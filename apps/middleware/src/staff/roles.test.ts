import { describe, expect, it } from "vitest";

import {
  CAPABILITIES,
  ROLES,
  can,
  capabilitiesOf,
  isAdministratorOnly,
  requiresMfa,
  type Capability,
} from "./roles";

/**
 * The role table from ticket 22, asserted in both directions — that a Support
 * Officer *cannot* do each Administrator thing matters at least as much as that
 * an Administrator can.
 */

const ADMINISTRATOR_WRITES: readonly Capability[] = [
  "officers.read",
  "tariff.write",
  "settings.write",
  "connectors.write",
  "snippet.write",
  "officers.write",
  // Library text is model-facing text the Bank writes — the same argument that
  // makes Connector registration Administrator-only. An Officer reads what the
  // Support Agent may quote; only an Administrator decides what that is.
  "library.write",
];

const BOTH: readonly Capability[] = [
  "inbox.work",
  "customers.read",
  "beneficiaries.read",
  "binding.revoke",
  "audit.read",
  "tariff.read",
  "settings.read",
];

describe("the roles nest rather than partition", () => {
  it("gives an Administrator everything a Support Officer has", () => {
    for (const capability of capabilitiesOf("support_officer")) {
      expect(can("administrator", capability)).toBe(true);
    }
  });

  it("has no capability an Officer holds and an Administrator does not", () => {
    // The failure this rules out: "administrator but not officer", which a
    // bank with people doing both jobs would work around within a week.
    const officerOnly = [...capabilitiesOf("support_officer")].filter(
      (capability) => !can("administrator", capability),
    );

    expect(officerOnly).toEqual([]);
  });

  it("ships exactly two roles", () => {
    expect([...ROLES]).toEqual(["support_officer", "administrator"]);
  });
});

describe("what a Support Officer may do", () => {
  it.each(BOTH)("may %s", (capability) => {
    expect(can("support_officer", capability)).toBe(true);
  });

  it.each(ADMINISTRATOR_WRITES)("may NOT %s", (capability) => {
    expect(can("support_officer", capability)).toBe(false);
  });
});

describe("what an Administrator may do", () => {
  it.each([...BOTH, ...ADMINISTRATOR_WRITES])("may %s", (capability) => {
    expect(can("administrator", capability)).toBe(true);
  });
});

describe("the table is complete", () => {
  it("assigns every named capability to at least one role", () => {
    const unassigned = CAPABILITIES.filter(
      (capability) => !can("support_officer", capability) && !can("administrator", capability),
    );

    expect(unassigned).toEqual([]);
  });

  it("agrees with isAdministratorOnly", () => {
    for (const capability of CAPABILITIES) {
      expect(isAdministratorOnly(capability)).toBe(!can("support_officer", capability));
    }
  });

  it("names the Administrator-only capabilities the role table listed", () => {
    // The tariff decides what Customers are charged, the Snippet issues a
    // signing secret, a Connector grants the Support Agent a capability, and
    // Officer accounts decide who else gets in.
    expect(CAPABILITIES.filter(isAdministratorOnly).sort()).toEqual(
      [...ADMINISTRATOR_WRITES].sort(),
    );
  });
});

describe("MFA", () => {
  it("is required for the role that can change what Customers are charged", () => {
    expect(requiresMfa("administrator")).toBe(true);
  });

  it("is optional for a Support Officer in v1", () => {
    expect(requiresMfa("support_officer")).toBe(false);
  });
});
