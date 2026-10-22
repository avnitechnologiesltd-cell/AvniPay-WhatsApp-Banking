import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { SealedValueError, open, seal } from "./encryption";

const KEY = randomBytes(32).toString("base64");
const OTHER_KEY = randomBytes(32).toString("base64");

describe("sealing a value the Middleware must read back", () => {
  it("opens to what went in", () => {
    expect(open(KEY, seal(KEY, "a-signing-secret"))).toBe("a-signing-secret");
  });

  it("produces a different ciphertext every time", () => {
    // A fresh IV per call. Reusing one under GCM is catastrophic rather than
    // merely weak, and two identical rows would say two Connectors share a
    // credential without anybody opening either.
    expect(seal(KEY, "the same secret")).not.toBe(seal(KEY, "the same secret"));
  });

  it("refuses to open under a different key", () => {
    expect(() => open(OTHER_KEY, seal(KEY, "a-signing-secret"))).toThrow(SealedValueError);
  });

  it("refuses a ciphertext somebody edited", () => {
    // Authenticated encryption, so a row edited in the database fails to open
    // rather than decrypting to something else.
    const sealed = Buffer.from(seal(KEY, "a-signing-secret"), "base64");
    sealed.writeUInt8(sealed.readUInt8(sealed.length - 1) ^ 0xff, sealed.length - 1);

    expect(() => open(KEY, sealed.toString("base64"))).toThrow(SealedValueError);
  });

  it("refuses a key that is not 32 bytes", () => {
    expect(() => seal(randomBytes(16).toString("base64"), "x")).toThrow(SealedValueError);
  });

  it("refuses a stored value too short to be one", () => {
    expect(() => open(KEY, Buffer.alloc(8).toString("base64"))).toThrow(SealedValueError);
  });
});
