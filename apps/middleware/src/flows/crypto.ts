import {
  constants,
  createDecipheriv,
  createCipheriv,
  privateDecrypt,
  type KeyObject,
} from "node:crypto";

/**
 * The sealed channel every authorisation on the platform depends on.
 *
 * WhatsApp Flows in endpoint mode post their contents encrypted, and this is
 * the only place they are opened. It lives in the **Middleware** because
 * routing it through the Platform would put every Transaction PIN in plaintext
 * through the layer running the LLM
 * ([ADR-0007](../../../../docs/adr/0007-flow-confirmations-terminate-at-the-middleware.md)).
 *
 * ## The scheme
 *
 * 1. The client generates a **128-bit AES key** and an IV, and wraps the key
 *    for us with **RSA-OAEP, SHA-256** against the public half we uploaded to
 *    Meta.
 * 2. The body is **AES-128-GCM**, with the 16-byte auth tag appended to the
 *    ciphertext rather than carried separately.
 * 3. **The response is encrypted under the same AES key, with every bit of the
 *    IV flipped.**
 *
 * That third step is undocumented folklore, ported from the prior repository,
 * and it is the highest-value thing in it. Reusing a key and IV pair under GCM
 * is catastrophic — it leaks the XOR of the two plaintexts and, worse, the
 * authentication subkey — so the flip is what keeps the response safe rather
 * than a stylistic choice. Get it wrong and every Flow on both Channels fails,
 * which is why there are known-vector tests beside this file and not only a
 * journey.
 */

/** WhatsApp Flows uses AES-128: the unwrapped key is 16 bytes, never 32. */
const AES_KEY_BYTES = 16;

/**
 * **The IV's length is whatever Meta sends**, and it is not 12.
 *
 * GCM's standard nonce is 12 bytes and it is tempting to require one. Meta
 * sends **16**, and refusing it is a `421` on every real exchange — the health
 * check included, which is where this was found. The published prior art passes
 * the IV straight to the cipher and has always worked; this file checked a
 * constant from the specification instead of the one on the wire.
 *
 * So the bound below is the cipher's own: GCM accepts 1–16 bytes, and Node
 * requires `authTagLength` to be stated for anything but 12. Nothing is gained
 * by being stricter than the counterparty, and a whole integration is lost.
 */
const MAX_IV_BYTES = 16;

/** GCM's tag, appended to the ciphertext rather than sent alongside it. */
const AUTH_TAG_BYTES = 16;

/** The three fields WhatsApp posts. */
export interface EncryptedFlowRequest {
  readonly encrypted_flow_data: string;
  readonly encrypted_aes_key: string;
  readonly initial_vector: string;
}

/** What came out, plus what is needed to seal the answer. */
export interface OpenedFlowRequest {
  /** The decrypted body, parsed. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** Held only for the length of one request. */
  readonly aesKey: Buffer;
  readonly initialVector: Buffer;
}

/**
 * Thrown for anything that does not open.
 *
 * Carries a `reason` for the operational log and the audit table, and nothing
 * a caller should ever put in a response: a payload that fails to decrypt is
 * either Meta rotating a key or somebody probing, and telling the two apart is
 * our job rather than theirs.
 */
export class FlowDecryptionError extends Error {
  public override readonly name = "FlowDecryptionError";

  public constructor(public readonly reason: string) {
    super(`The Flow payload could not be opened: ${reason}`);
  }
}

const decodeBase64 = (value: unknown, field: string): Buffer => {
  if (typeof value !== "string" || value.length === 0) {
    throw new FlowDecryptionError(`${field} is missing`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0) throw new FlowDecryptionError(`${field} is not base64`);
  return decoded;
};

/**
 * Every bit of the IV inverted.
 *
 * The whole of the folklore, in one line. Written as its own exported function
 * so a test can assert the bytes directly — a round-trip through our own code
 * would pass just as happily if this were the identity function.
 */
export const flipInitialVector = (initialVector: Buffer): Buffer =>
  Buffer.from(initialVector.map((byte) => ~byte & 0xff));

/** Unwraps the AES key, then opens the body. */
export const decryptFlowRequest = (
  body: unknown,
  privateKey: KeyObject,
): OpenedFlowRequest => {
  const request = (body ?? {}) as Partial<EncryptedFlowRequest>;

  const wrappedKey = decodeBase64(request.encrypted_aes_key, "encrypted_aes_key");
  const initialVector = decodeBase64(request.initial_vector, "initial_vector");
  const sealed = decodeBase64(request.encrypted_flow_data, "encrypted_flow_data");

  let aesKey: Buffer;
  try {
    aesKey = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      wrappedKey,
    );
  } catch {
    // Meta's convention: answer 421 so the client re-fetches the public key.
    throw new FlowDecryptionError("the AES key did not unwrap under our private key");
  }

  if (aesKey.length !== AES_KEY_BYTES) {
    throw new FlowDecryptionError(`the AES key is ${aesKey.length} bytes, not ${AES_KEY_BYTES}`);
  }
  if (initialVector.length === 0 || initialVector.length > MAX_IV_BYTES) {
    throw new FlowDecryptionError(
      `the IV is ${initialVector.length} bytes, which AES-GCM cannot take`,
    );
  }
  if (sealed.length <= AUTH_TAG_BYTES) {
    throw new FlowDecryptionError("the body is too short to carry an auth tag");
  }

  // The tag is the last 16 bytes, not a separate field.
  const ciphertext = sealed.subarray(0, sealed.length - AUTH_TAG_BYTES);
  const authTag = sealed.subarray(sealed.length - AUTH_TAG_BYTES);

  let opened: Buffer;
  try {
    // `authTagLength` is required whenever the IV is not 12 bytes, and Meta's
    // is 16. Stated always, because the value is the same either way.
    const decipher = createDecipheriv("aes-128-gcm", aesKey, initialVector, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAuthTag(authTag);
    opened = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // The tag failing is tampering or corruption. Never distinguished outward.
    throw new FlowDecryptionError("the body failed authentication");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(opened.toString("utf8"));
  } catch {
    throw new FlowDecryptionError("the body is not JSON");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new FlowDecryptionError("the body is not an object");
  }

  return { payload: payload as Record<string, unknown>, aesKey, initialVector };
};

/**
 * Seals the answer under the **same key** with the **flipped IV**, and returns
 * base64 — WhatsApp expects the bare string as the response body, not JSON.
 */
export const encryptFlowResponse = (
  payload: unknown,
  aesKey: Buffer,
  initialVector: Buffer,
): string => {
  const cipher = createCipheriv("aes-128-gcm", aesKey, flipInitialVector(initialVector), {
    authTagLength: AUTH_TAG_BYTES,
  });
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);

  return Buffer.concat([ciphertext, cipher.getAuthTag()]).toString("base64");
};
