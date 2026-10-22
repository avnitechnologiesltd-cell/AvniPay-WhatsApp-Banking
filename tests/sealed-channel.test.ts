import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startHarness, type Harness } from "./harness";
import { allSourceFiles, packageNamed, sourceFilesOf } from "./workspace";

/**
 * The sealed channel's boundary, asserted from outside.
 *
 * [ADR-0007](../docs/adr/0007-flow-confirmations-terminate-at-the-middleware.md):
 * a Flow posts its contents to the **Middleware**, and the Platform never sees
 * them. Routing them through the Platform would put every Transaction PIN in
 * plaintext through the layer that runs the LLM, and no care downstream
 * recovers from that.
 */

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness?.stop();
});

describe("the Platform has no path to the sealed channel", () => {
  it("serves no Flows endpoint of its own", async () => {
    for (const path of ["/flows/whatsapp", "/flows", "/channels/whatsapp/flows"]) {
      expect((await fetch(`${harness.platformUrl}${path}`, { method: "POST" })).status).toBe(404);
    }
  });

  it("is where the Middleware serves one", async () => {
    // Unsigned, so refused — but refused by a route that exists, which is the
    // point. A 404 here would mean the Flow had nowhere to post.
    const response = await fetch(`${harness.middlewareUrl}/flows/whatsapp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).not.toBe(404);
    expect(response.status).toBe(432);
  });

  it("serves no sealed surface for the Widget either", async () => {
    // The Platform serves the Widget's *code*, which is safe precisely because
    // every value that code collects goes somewhere else. A route here that
    // accepted one would undo that in a line.
    for (const path of ["/widget/surface", "/widget/v1/surface", "/surfaces/in-app"]) {
      expect((await fetch(`${harness.platformUrl}${path}`, { method: "POST" })).status).toBe(404);
    }
  });

  it("is where the Middleware serves that one too", async () => {
    const response = await fetch(`${harness.middlewareUrl}/widget/surface`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    // A route that exists, refusing a token that names nothing.
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ screen: "UNAVAILABLE" });
  });
});

describe("the Platform holds no key material", () => {
  it("has no Flows key or passphrase in its configuration", () => {
    const config = packageNamed("@avni/config");
    const source = sourceFilesOf(config)
      .map((file) => file.contents)
      .join("\n");

    // The Middleware's shape reads them; the Platform's must not.
    const platformShape = source.slice(
      source.indexOf("const platformShape"),
      source.indexOf("export interface PlatformConfig"),
    );

    expect(platformShape).not.toContain("WA_FLOW_PRIVATE_KEY_PATH");
    expect(platformShape).not.toContain("WA_FLOW_PASSPHRASE");
    expect(platformShape).not.toContain("WHATSAPP_APP_SECRET");
  });

  it("has no credential for the Bank's identity API, and no enrollment secret", () => {
    // The identity API is how a code reaches a contact on record. A Platform
    // that could call it could send one, and a Platform holding the decoy key
    // could tell a real destination list from a fabricated one.
    const config = packageNamed("@avni/config");
    const source = sourceFilesOf(config)
      .map((file) => file.contents)
      .join("\n");

    const platformShape = source.slice(
      source.indexOf("const platformShape"),
      source.indexOf("export interface PlatformConfig"),
    );

    expect(platformShape).not.toContain("BANK_IDENTITY_API_KEY");
    expect(platformShape).not.toContain("BANK_IDENTITY_API_BASE");
    expect(platformShape).not.toContain("ENROLLMENT_DECOY_SECRET");
    expect(platformShape).not.toContain("NUBAN_BANK_CODE");
  });

  it("keeps the crypto and the key loader inside the Middleware", () => {
    const offenders = allSourceFiles()
      .filter(
        (file) =>
          file.relativePath.startsWith("apps/platform/") ||
          file.relativePath.startsWith("packages/platform-"),
      )
      .filter((file) =>
        /createPrivateKey|privateDecrypt|flipInitialVector|decryptFlowRequest|RSA_PKCS1_OAEP/.test(
          file.contents,
        ),
      )
      .map((file) => file.relativePath);

    expect(offenders).toEqual([]);
  });

  it("holds no Transaction PIN, and nothing that could store one", () => {
    // The PIN authorises every transfer and every Gated Connector. It reaches
    // the Middleware through a sealed surface and is never a value in the layer
    // that reads Customer text into an LLM (ADR-0006).
    const offenders = allSourceFiles()
      .filter(
        (file) =>
          file.relativePath.startsWith("apps/platform/") ||
          file.relativePath.startsWith("packages/platform-"),
      )
      .filter((file) => /transaction_pins|argon2|hashSecret|pinProblem/.test(file.contents))
      .map((file) => file.relativePath);

    expect(offenders).toEqual([]);
  });

  it("declares no dependency that would give it the crypto", () => {
    for (const name of [
      "@avni/platform",
      "@avni/platform-channels",
      "@avni/platform-orchestration",
      "@avni/platform-support",
    ]) {
      expect(packageNamed(name).dependencies).not.toContain("@avni/middleware");
    }
  });
});
