import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHmac,
  generateKeyPairSync,
  publicEncrypt,
  randomBytes,
} from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Standing in for WhatsApp's Flows client.
 *
 * A test that needs to post a sealed Flow payload needs three things: a keypair
 * whose private half is on disk where the deployment mounts one, a way to seal
 * a request under it, and a way to open the answer. All three live here so that
 * every slice which adds a screen — enrollment, the Confirmation screen, PIN
 * entry — gets them rather than re-deriving the wire format.
 *
 * **Generated per run, never read from `secrets/`.** A suite that needs a
 * production secret to pass cannot run on a fresh clone, and the real key is
 * the Bank's rather than a fixture.
 */

export const FLOWS_PASSPHRASE = "test-flows-passphrase";

export interface FlowsKeypair {
  /** Where the private half was written, for `WA_FLOW_PRIVATE_KEY_PATH`. */
  readonly keyPath: string;
  readonly passphrase: string;
  /** The half Meta would hold, for sealing a request. */
  readonly publicKeyPem: string;
}

export const writeFlowsKeypair = (passphrase = FLOWS_PASSPHRASE): FlowsKeypair => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  const keyPath = join(
    mkdtempSync(join(tmpdir(), "avni-flows-")),
    "whatsapp-flow-private.pem",
  );
  writeFileSync(keyPath, privateKey, { mode: 0o600 });

  return { keyPath, passphrase, publicKeyPem: publicKey };
};

export interface SealedFlowRequest {
  /** The three fields WhatsApp posts. */
  readonly body: {
    readonly encrypted_aes_key: string;
    readonly initial_vector: string;
    readonly encrypted_flow_data: string;
  };
  readonly aesKey: Buffer;
  readonly initialVector: Buffer;
}

/**
 * Seals a payload the way the client does: a fresh AES-128 key wrapped with
 * RSA-OAEP/SHA-256, AES-128-GCM over the body, and the 16-byte auth tag
 * **appended to the ciphertext** rather than sent as its own field.
 */
export const sealFlowRequest = (
  publicKeyPem: string,
  payload: unknown,
): SealedFlowRequest => {
  const aesKey = randomBytes(16);
  const initialVector = randomBytes(12);

  const cipher = createCipheriv("aes-128-gcm", aesKey, initialVector);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);

  return {
    body: {
      encrypted_aes_key: publicEncrypt(
        { key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        aesKey,
      ).toString("base64"),
      initial_vector: initialVector.toString("base64"),
      encrypted_flow_data: Buffer.concat([ciphertext, cipher.getAuthTag()]).toString("base64"),
    },
    aesKey,
    initialVector,
  };
};

/**
 * Opens a sealed answer the way the client does: **the same key, with every
 * bit of the IV flipped.**
 *
 * Written independently of the Middleware's own implementation, so a test using
 * this is checking the contract rather than agreeing with itself.
 */
export const openFlowResponse = (
  sealed: string,
  aesKey: Buffer,
  initialVector: Buffer,
): unknown => {
  const flipped = Buffer.from(initialVector.map((byte) => ~byte & 0xff));
  const raw = Buffer.from(sealed, "base64");

  const decipher = createDecipheriv("aes-128-gcm", aesKey, flipped);
  decipher.setAuthTag(raw.subarray(raw.length - 16));

  return JSON.parse(
    Buffer.concat([
      decipher.update(raw.subarray(0, raw.length - 16)),
      decipher.final(),
    ]).toString("utf8"),
  );
};

/** `X-Hub-Signature-256` over the exact bytes that will be sent. */
export const signFlowBody = (rawBody: string, appSecret: string): string =>
  `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
