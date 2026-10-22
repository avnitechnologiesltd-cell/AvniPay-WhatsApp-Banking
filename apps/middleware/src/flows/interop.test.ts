import { createPrivateKey } from "node:crypto";

import { describe, expect, it } from "vitest";

import { decryptFlowRequest } from "./crypto";

/**
 * The one property the other tests cannot catch.
 *
 * Everywhere else, a test seals a request with **our** settings and opens it
 * with **our** settings. Change `oaepHash` from `"sha256"` to `"sha1"` and all
 * of it still passes — while every real Flow fails, because Meta's client is a
 * different implementation.
 *
 * So this vector was produced by Python's `cryptography` using the parameters
 * the prior implementation used and Meta's spec requires — `OAEP(mgf=MGF1(SHA256),
 * algorithm=SHA256)` — and is opened here with no help from our own encrypt path.
 *
 * The key below is a throwaway generated for this file. It protects nothing.
 */

const FOREIGN_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDxOZK1S5mEXxDD
94c4DUEmeMs/lvt5wcUB8BjLrpOLj6348tRUBHleDjyL/AFon3TJMMh4RkAqvRmv
qM9FPGBA55dRP8rhqvomxSISi6gum7gVvNH/snvZEKevGFk3xRt8sVzcX1xzsikG
QJR5HaDntAcWyBsLISEs/XdupN8h3BSG4Hg6KmnKHxtURuL2afbDO6c1cx/VBblJ
Ejp3XqvDrcULspqWMHR/UTMn6zOB25bzuzQ7MV1SyfSL8bCOVF4/gvKqM4L9ijSp
lB+MBSmxsSXj9elCZFXxRBG3MRvjXS13ddsWtlwavTYws67u9eSZ5GT0/5sjIY+z
/XfQD2etAgMBAAECggEADJFh1eVC8dUcJAGk/2QdZVo8yKrenkjcsU2nlREa6dYK
C+Lm8hurkR1vxSFTl3ZbWNIcV7vdQvzINlE2v1Y2c5s9VIPc16YXU2bI8Ctrj0YY
sLU+QbK0ZipKekJr/45a8MOy4V5sjDCXl5ZMxgSnqfrEtcimNA29U0E/dDnN0E8z
sdSM2cq89Vwj4i84uyqP8drT8mGZi4uu3ioXoNxZ84iDIkePzWaDKmpWSa2IgdJq
MQvK8xQDKbcNvGtnwtir7tNho9hTATXnTP4s+4BeODe1fkziMeaTfg+kKCfskjtL
z6rMVVM/fqsaWmmyASARioo2qWprq+Q2xkQ8m9F7FwKBgQD+R23Dwv0Ey7aZVXjn
VVKKezoOT5Arnk62N1jmz3+KXti/z+5G6xtvYdRIeweqGgkPO2TyBILfKaxJt9g8
eVdo49grDxT2o0IkauET2E8wBowyfIufqzYYnPK7znYHcR5pNiZZO8OmhfVmfyTS
nMBbTIFhjPpR3fVD4U9C2zFAvwKBgQDy24a/PHc5uelocTUnbDZqo1eR/BNRZV6M
eKEWjh6SprzA8ootlYp2XpDFCX7eqYsUHM3EpCWlgU6XfLTJa+NyOmR00TdNElm4
FTPtsu9QaE9e12+mAzxhWCGisrSnDAcOtRms9M7iknLwTmabCCqddldW9KEAXykF
uTA4xq1GkwKBgQD4Z6E0Z80znSsB+jzFiVW8UQtzJYjLA7kTS1h/CuAmted64s98
2nsPwXtXX1EqfIqzJavEvmF3T0evMHl/Am9A2ay4y+AH3Y9k8kB1WZBqc0sMmxzv
W5vaSaDblaM6O+igkbS+4aKNkDoe6kB3u4gy6LdQLB/yUColKPt8bZNdEwKBgAox
uttGL38F1c1jiyanfTVGvANNwIXXKnvdCG4I8zGWvC+hPrmhIFnNqGgM+P1hwovK
lbyeY1IqNmFXg8M8uyRtXRAmRBsBHTED+tUMgM0wQ7yocHBYjG1NpMPOmpS0hYtR
gM1ozVJncVmzAM2bLybC8/GbfTKly/QIjQSlGlrvAoGAQ67CRLWoWvgQ8BrXQBxS
hApBTKMDHJrkaF2KgLepepRy7dv5wlGliXPHD0As9GjVv76kAwhnFc1M+kAa0vkN
ROFriO7xUhX2G//aJC28xPbUf62SCDIk3Gq7PPR6OILg4Lr0n807lseasnY4XtQa
q2adTkQMYW4HoqPkUZ44k5A=
-----END PRIVATE KEY-----`;

/** The AES key 00..0f, wrapped by Python with MGF1-SHA256 / SHA-256. */
const FOREIGN_WRAPPED_KEY =
  "69MnB+rAvfaNApsIcX/LehaYR2cCIiv+F/eKjmF43l5XaFyWSNULBM2hBZQaoHsEVwkdvO1qB+3hMD7m7LnlmlGqCVfUgZZVTc5L+AMZC/P+Zm6IxG1zFIidIE4HKFyDGVs/ntN9D668FPQmW4GsoELbuNdV/kBF/iaZZxyAPKlu36jx/pzkhVBDTGA/79RCHPLQ9mr7EgMy/eR75Fw3v1lVllw2Q4XZAFQr1WU4xoD9Tl4bbbjZiYSMD53NpDC4qzyEiUd74VtfW85ImPlw4v8N8jDWzTMZ1gibR0rtYH3XcjYhDUtc8q/MiYLEKTZcJ2HiTyYhBlKUykXpvRqfJw==";

/** `{"action":"ping"}` under that key with IV 10..1b, sealed by Python. */
const FOREIGN_SEALED_BODY = "vwxizHsm2YE153+FrkmMHEcD4n74kteYqZmb5yiwOlwK";
const FOREIGN_IV = Buffer.from("101112131415161718191a1b", "hex").toString("base64");

describe("interoperating with a different implementation", () => {
  it("opens a request another implementation sealed, end to end", () => {
    const opened = decryptFlowRequest(
      {
        encrypted_aes_key: FOREIGN_WRAPPED_KEY,
        initial_vector: FOREIGN_IV,
        encrypted_flow_data: FOREIGN_SEALED_BODY,
      },
      createPrivateKey(FOREIGN_PRIVATE_KEY),
    );

    expect(opened.payload).toEqual({ action: "ping" });
  });

  it("recovers the exact AES key that was wrapped", () => {
    // If our OAEP parameters drifted, this is where it shows — and nowhere else,
    // because every other test wraps and unwraps with the same settings.
    const opened = decryptFlowRequest(
      {
        encrypted_aes_key: FOREIGN_WRAPPED_KEY,
        initial_vector: FOREIGN_IV,
        encrypted_flow_data: FOREIGN_SEALED_BODY,
      },
      createPrivateKey(FOREIGN_PRIVATE_KEY),
    );

    expect(opened.aesKey.toString("hex")).toBe("000102030405060708090a0b0c0d0e0f");
  });
});
