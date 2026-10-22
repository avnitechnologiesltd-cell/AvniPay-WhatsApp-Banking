import { readFileSync } from "node:fs";
import { createPrivateKey, type KeyObject } from "node:crypto";

import type { WhatsAppConfig } from "@avni/config";

/**
 * Loads the Flows private key from the **mounted path** in configuration.
 *
 * Never a literal, and never an environment string. The `.env` file holds the
 * *path*; the `.pem` is mounted beside it read-only, and a value that looks
 * like key material is already refused when the configuration is parsed.
 *
 * Read once at boot rather than per request: a key that only fails to load on
 * the first Customer authorisation is a key that fails at the worst moment.
 */
export class FlowKeyError extends Error {
  public override readonly name = "FlowKeyError";

  public constructor(path: string, reason: string) {
    super(
      `The WhatsApp Flows private key at ${path} could not be loaded: ${reason}. ` +
        "Check WA_FLOW_PRIVATE_KEY_PATH and WA_FLOW_PASSPHRASE, and that the file is mounted.",
    );
  }
}

export const loadFlowsPrivateKey = (whatsapp: WhatsAppConfig): KeyObject => {
  const { privateKeyPath, passphrase } = whatsapp.flows;

  let pem: string;
  try {
    pem = readFileSync(privateKeyPath, "utf8");
  } catch (error) {
    throw new FlowKeyError(
      privateKeyPath,
      error instanceof Error ? error.message : "it could not be read",
    );
  }

  try {
    return createPrivateKey({ key: pem, passphrase });
  } catch (error) {
    // Overwhelmingly the wrong passphrase, and worth saying so: the message an
    // operator gets here decides whether they spend the afternoon on the file
    // permissions instead.
    throw new FlowKeyError(
      privateKeyPath,
      error instanceof Error ? error.message : "it is not a usable private key",
    );
  }
};
