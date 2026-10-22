/**
 * Two roles, and what each may do.
 *
 * **They nest rather than partition.** Every Administrator is also a Support
 * Officer, because a bank this size has people who do both jobs, and two roles
 * that cannot be held together would be worked around within a week.
 *
 * Two and not more. Three separate tickets argued that one role is
 * insufficient — Connector registration grants the Support Agent a capability,
 * Snippet generation issues the identity-signing secret, and the fee tariff
 * changes what a Customer is charged. **None argued for a permission system.**
 * A read-only auditor role was considered and rejected: the audit log serves
 * that need better than a login does.
 *
 * This file knows nothing about *how* somebody proved who they are. That is
 * deliberate — see `authentication.ts`. An OIDC adapter added later resolves to
 * a `StaffAccount` and everything below keeps working untouched.
 */

export const ROLES = ["support_officer", "administrator"] as const;

export type Role = (typeof ROLES)[number];

/**
 * Everything a human can do in the Dashboard, named once.
 *
 * A capability rather than a screen, because two screens can need the same
 * permission and a screen can need two. Named after the act, so a reviewer
 * reading the table below is reading the product decision rather than a routing
 * table.
 */
export const CAPABILITIES = [
  // Both roles.
  "inbox.work",
  "customers.read",
  "beneficiaries.read",
  "binding.revoke",
  "audit.read",
  "tariff.read",
  "settings.read",
  "library.read",

  // Administrator only. Note `officers.read` is here rather than above: the
  // role table gives a Support Officer **no** access to the Officer list, not
  // read-only access — who else can get in is not their business.
  "officers.read",
  "tariff.write",
  "settings.write",
  "connectors.write",
  "snippet.write",
  "officers.write",
  // Library text is **model-facing text the Bank writes** — the same reason
  // Connector registration is Administrator-only. A Support Officer reads what
  // the Agent may quote; only an Administrator decides what that is.
  "library.write",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * What a Support Officer may do. An Administrator may do all of this **and**
 * the rest — expressed by the nesting below rather than by a second list, so
 * the two can never drift apart.
 */
const SUPPORT_OFFICER: readonly Capability[] = [
  "inbox.work",
  "customers.read",
  "beneficiaries.read",
  "binding.revoke",
  "audit.read",
  "tariff.read",
  "settings.read",
  "library.read",
];

/** What an Administrator may do that a Support Officer may not. */
const ADMINISTRATOR_ONLY: readonly Capability[] = [
  "officers.read",
  "tariff.write",
  "settings.write",
  "connectors.write",
  "snippet.write",
  "officers.write",
  "library.write",
];

const BY_ROLE: Record<Role, ReadonlySet<Capability>> = {
  support_officer: new Set(SUPPORT_OFFICER),
  // The nesting, in one line. There is no way to hold "administrator but not
  // officer", because there is no list that says so.
  administrator: new Set([...SUPPORT_OFFICER, ...ADMINISTRATOR_ONLY]),
};

export const capabilitiesOf = (role: Role): ReadonlySet<Capability> => BY_ROLE[role];

export const can = (role: Role, capability: Capability): boolean =>
  BY_ROLE[role].has(capability);

/** True when only an Administrator may do it. Used by tests and the Dashboard. */
export const isAdministratorOnly = (capability: Capability): boolean =>
  ADMINISTRATOR_ONLY.includes(capability);

/** MFA is required for the role that can change what Customers are charged. */
export const requiresMfa = (role: Role): boolean => role === "administrator";
