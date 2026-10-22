import {
  constants,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  publicEncrypt,
  randomBytes,
  type KeyObject,
} from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  FlowDecryptionError,
  decryptFlowRequest,
  encryptFlowResponse,
  flipInitialVector,
} from "./crypto";

/**
 * The two tests that matter here are the **known vectors**, and they matter
 * because a round-trip through our own code proves nothing about the folklore.
 * If `flipInitialVector` were the identity function, every round-trip below
 * would still pass and every real Flow would fail.
 *
 * So the vectors were computed with a different implementation of AES-GCM
 * (Python's `cryptography`) and pasted in. They are a source of truth outside
 * this file.
 */

// --- Vectors, computed independently of the code under test ------------------

const KEY = Buffer.from("AAECAwQFBgcICQoLDA0ODw==", "base64"); // 00..0f
const IV = Buffer.from("EBESExQVFhcYGRob", "base64"); // 10..1b
const REQUEST_PLAINTEXT = '{"screen":"CONFIRM","data":{"amount":5000}}';
const REQUEST_SEALED =
  "vwxwzH0q04E153+2iGmtd2jxVqsUkArL5OkTakVkfMKnt1Udu5PLLNPdqOLosj+P7dxFcywfVDa9q2Y=";

const RESPONSE_PLAINTEXT = { data: { status: "active" } };
/** Encrypted under the same key with the IV **flipped**. */
const RESPONSE_SEALED = "B2zQ9zylJJuVZ7R4QdZus15Uxx9OipWA/hayCF5cTDhWoQNHgW89Qyig4sc=";
/** What a forgot-to-flip implementation produces. Must never be our output. */
const RESPONSE_WITH_UNFLIPPED_IV = "vwxnznsulNVs/y6BplOeTRiGVuZVgALJ4OlUbEzrYEvGy4N5yurkhaUzGOc=";

const keypair = (): { privateKey: KeyObject; publicKey: KeyObject } => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { privateKey, publicKey };
};

/** Builds a request the way WhatsApp's client does. */
const sealRequest = (
  publicKey: KeyObject,
  payload: unknown,
  options: { key?: Buffer; iv?: Buffer } = {},
) => {
  const aesKey = options.key ?? randomBytes(16);
  const initialVector = options.iv ?? randomBytes(12);

  const cipher = createCipheriv("aes-128-gcm", aesKey, initialVector);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);

  return {
    body: {
      encrypted_aes_key: publicEncrypt(
        { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        aesKey,
      ).toString("base64"),
      initial_vector: initialVector.toString("base64"),
      // The tag is appended to the ciphertext, not carried separately.
      encrypted_flow_data: Buffer.concat([ciphertext, cipher.getAuthTag()]).toString("base64"),
    },
    aesKey,
    initialVector,
  };
};

describe("flipInitialVector — the folklore, checked directly", () => {
  it("inverts every bit", () => {
    expect(flipInitialVector(IV).toString("hex")).toBe("efeeedecebeae9e8e7e6e5e4");
  });

  it("is its own inverse, which is what lets the client undo it", () => {
    expect(flipInitialVector(flipInitialVector(IV))).toEqual(IV);
  });

  it("changes the IV, so a round-trip through our own code cannot be vacuous", () => {
    expect(flipInitialVector(IV)).not.toEqual(IV);
  });

  it("leaves the length alone", () => {
    expect(flipInitialVector(IV)).toHaveLength(IV.length);
  });

  it("handles the bytes a naive implementation gets wrong", () => {
    // `~0x00` is -1 in JavaScript, and `~0xff` is -256. Both must land in a
    // byte, and a missing `& 0xff` would silently produce the wrong buffer.
    expect(flipInitialVector(Buffer.from([0x00, 0xff, 0x80, 0x7f]))).toEqual(
      Buffer.from([0xff, 0x00, 0x7f, 0x80]),
    );
  });
});

describe("known vectors", () => {
  it("opens a body sealed by another implementation", () => {
    const { privateKey, publicKey } = keypair();
    const wrapped = publicEncrypt(
      { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      KEY,
    ).toString("base64");

    const opened = decryptFlowRequest(
      {
        encrypted_aes_key: wrapped,
        initial_vector: IV.toString("base64"),
        encrypted_flow_data: REQUEST_SEALED,
      },
      privateKey,
    );

    expect(opened.payload).toEqual(JSON.parse(REQUEST_PLAINTEXT));
  });

  it("seals a response another implementation can open", () => {
    expect(encryptFlowResponse(RESPONSE_PLAINTEXT, KEY, IV)).toBe(RESPONSE_SEALED);
  });

  it("does not produce what a forgotten IV flip would produce", () => {
    // The single assertion this whole file exists for.
    expect(encryptFlowResponse(RESPONSE_PLAINTEXT, KEY, IV)).not.toBe(
      RESPONSE_WITH_UNFLIPPED_IV,
    );
  });

  it("never reuses a key and IV pair across the request and the response", () => {
    // Reusing them under GCM leaks the XOR of the two plaintexts and the
    // authentication subkey. The flip is a safety property, not a style.
    const sealedResponse = Buffer.from(encryptFlowResponse(RESPONSE_PLAINTEXT, KEY, IV), "base64");
    const sealedRequest = Buffer.from(REQUEST_SEALED, "base64");

    expect(sealedResponse.subarray(0, 8)).not.toEqual(sealedRequest.subarray(0, 8));
  });
});

describe("a full exchange", () => {
  it("opens what WhatsApp's client sealed", () => {
    const { privateKey, publicKey } = keypair();
    const { body } = sealRequest(publicKey, { action: "data_exchange", screen: "PIN" });

    expect(decryptFlowRequest(body, privateKey).payload).toEqual({
      action: "data_exchange",
      screen: "PIN",
    });
  });

  it("hands back the key and IV so the answer can be sealed under them", () => {
    const { privateKey, publicKey } = keypair();
    const { body, aesKey, initialVector } = sealRequest(publicKey, { action: "ping" });

    const opened = decryptFlowRequest(body, privateKey);

    expect(opened.aesKey).toEqual(aesKey);
    expect(opened.initialVector).toEqual(initialVector);
  });

  it("seals an answer the client can open with the flipped IV", () => {
    const { privateKey, publicKey } = keypair();
    const { body } = sealRequest(publicKey, { action: "ping" });
    const opened = decryptFlowRequest(body, privateKey);

    const sealed = encryptFlowResponse({ data: { status: "active" } }, opened.aesKey, opened.initialVector);

    // Opened the way the client would: same key, flipped IV.
    const raw = Buffer.from(sealed, "base64");
    const decipher = createDecipheriv(
      "aes-128-gcm",
      opened.aesKey,
      flipInitialVector(opened.initialVector),
    );
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const plain = Buffer.concat([
      decipher.update(raw.subarray(0, raw.length - 16)),
      decipher.final(),
    ]).toString("utf8");

    expect(JSON.parse(plain)).toEqual({ data: { status: "active" } });
  });

  it("carries a Transaction PIN without it appearing anywhere in the clear", () => {
    const { privateKey, publicKey } = keypair();
    const { body } = sealRequest(publicKey, { action: "data_exchange", data: { pin: "1234" } });

    expect(JSON.stringify(body)).not.toContain("1234");
    expect(decryptFlowRequest(body, privateKey).payload).toMatchObject({
      data: { pin: "1234" },
    });
  });
});

describe("what must be refused", () => {
  const { privateKey, publicKey } = keypair();

  it("refuses a body wrapped for somebody else's key", () => {
    const other = keypair();
    const { body } = sealRequest(other.publicKey, { action: "ping" });

    expect(() => decryptFlowRequest(body, privateKey)).toThrow(FlowDecryptionError);
  });

  it("refuses a tampered body rather than returning what it can", () => {
    const { body } = sealRequest(publicKey, { action: "data_exchange", amount: 5000 });
    const tampered = Buffer.from(body.encrypted_flow_data, "base64");
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;

    expect(() =>
      decryptFlowRequest(
        { ...body, encrypted_flow_data: tampered.toString("base64") },
        privateKey,
      ),
    ).toThrow(/authentication/);
  });

  it("refuses a truncated auth tag", () => {
    const { body } = sealRequest(publicKey, { action: "ping" });
    const short = Buffer.from(body.encrypted_flow_data, "base64").subarray(0, 8);

    expect(() =>
      decryptFlowRequest({ ...body, encrypted_flow_data: short.toString("base64") }, privateKey),
    ).toThrow(FlowDecryptionError);
  });

  it("refuses an IV longer than AES-GCM can take", () => {
    // **Not 16.** Meta sends 16 and this file once refused it, which was a 421
    // on every real exchange. The bound is the cipher's, not the spec's.
    const { body } = sealRequest(publicKey, { action: "ping" });

    expect(() =>
      decryptFlowRequest(
        { ...body, initial_vector: randomBytes(17).toString("base64") },
        privateKey,
      ),
    ).toThrow(/IV/);
  });

  it("refuses a missing field rather than reading undefined", () => {
    const { body } = sealRequest(publicKey, { action: "ping" });

    for (const field of ["encrypted_aes_key", "initial_vector", "encrypted_flow_data"] as const) {
      expect(() => decryptFlowRequest({ ...body, [field]: undefined }, privateKey)).toThrow(
        FlowDecryptionError,
      );
    }
    expect(() => decryptFlowRequest({}, privateKey)).toThrow(FlowDecryptionError);
    expect(() => decryptFlowRequest(null, privateKey)).toThrow(FlowDecryptionError);
  });

  it("refuses a decrypted body that is not a JSON object", () => {
    const { body } = sealRequest(publicKey, "just a string");

    expect(() => decryptFlowRequest(body, privateKey)).toThrow(/not an object/);
  });

  it("says nothing a caller should repeat outward", () => {
    // The reason is for the log and the audit table. Distinguishing "wrong
    // key" from "tampered" for a caller is an oracle.
    const other = keypair();
    const { body } = sealRequest(other.publicKey, { action: "ping" });

    try {
      decryptFlowRequest(body, privateKey);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FlowDecryptionError);
      expect((error as FlowDecryptionError).reason).toBeTruthy();
    }
  });
});

describe("against a key loaded from a PEM, as the deployment does", () => {
  it("opens a request using a key read from disk", () => {
    const { privateKey, publicKey } = keypair();
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    const { body } = sealRequest(publicKey, { action: "ping" });

    expect(decryptFlowRequest(body, createPrivateKey(pem)).payload).toEqual({ action: "ping" });
  });

  it("opens a request using a passphrase-protected key, which is what ships", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "s3cret" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const { body } = sealRequest(createPublicKey(publicKey), { action: "ping" });

    const loaded = createPrivateKey({ key: privateKey, passphrase: "s3cret" });

    expect(decryptFlowRequest(body, loaded).payload).toEqual({ action: "ping" });
  });
});

describe("the IV Meta actually sends", () => {
  /**
   * **Meta's IV is 16 bytes, not GCM's usual 12.** This file once required 12
   * and rejected every real exchange with a `421`, health check included — the
   * specification's number checked in place of the one on the wire. The prior
   * art never had the bug because it passes the IV straight to the cipher.
   */
  it("opens a request sealed with a 16-byte IV", () => {
    const { privateKey, publicKey } = keypair();
    const aesKey = randomBytes(16);
    const initialVector = randomBytes(16);
    const payload = { action: "ping" };

    const cipher = createCipheriv("aes-128-gcm", aesKey, initialVector, { authTagLength: 16 });
    const body = Buffer.concat([
      cipher.update(JSON.stringify(payload), "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]);

    const opened = decryptFlowRequest(
      {
        encrypted_aes_key: publicEncrypt(
          { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
          aesKey,
        ).toString("base64"),
        initial_vector: initialVector.toString("base64"),
        encrypted_flow_data: body.toString("base64"),
      },
      privateKey,
    );

    expect(opened.payload).toEqual(payload);
    expect(opened.initialVector).toHaveLength(16);
  });

  it("seals the answer under the same 16-byte IV, flipped", () => {
    const aesKey = randomBytes(16);
    const initialVector = randomBytes(16);

    const sealed = Buffer.from(encryptFlowResponse({ data: { status: "active" } }, aesKey, initialVector), "base64");

    const decipher = createDecipheriv(
      "aes-128-gcm",
      aesKey,
      Buffer.from(initialVector.map((b) => ~b & 0xff)),
      { authTagLength: 16 },
    );
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    const opened = Buffer.concat([
      decipher.update(sealed.subarray(0, sealed.length - 16)),
      decipher.final(),
    ]);

    expect(JSON.parse(opened.toString("utf8"))).toEqual({ data: { status: "active" } });
  });
});
