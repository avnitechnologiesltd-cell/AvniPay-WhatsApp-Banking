import { ask, type Session } from "./middleware-client";

/**
 * **Connectors**: the HTTP APIs the Bank registers at runtime, which the Support
 * Agent may call on a Customer's behalf.
 *
 * The screen behind this module is the one place a Bank can give their Support
 * Agent a new capability without a release from us — and the one place they can
 * hand it something dangerous, which is why almost everything here is about what
 * this module *cannot* do:
 *
 * - **It never reads a credential back.** There is no field for one on the way
 *   out, because there is no route that would answer with one. Changing a
 *   credential means entering a new one.
 * - **It grants nothing.** Every write posts to the Middleware, which checks
 *   `connectors.write`, records the attempt and refuses a Support Officer — so
 *   the screen can render for both roles and hide the forms for tidiness alone.
 * - **It validates nothing important.** The endpoint policy and the rule that a
 *   parameter may not name the Customer live in the Middleware, beside the code
 *   that acts on them, and come back as sentences an Administrator can act on.
 */

export type ConnectorParameterType = "string" | "number" | "boolean";

export interface ConnectorParameter {
  readonly name: string;
  readonly type: ConnectorParameterType;
  readonly required: boolean;
  /** One line, read by the Support Agent when it fills the field in. */
  readonly description: string;
}

/**
 * One Connector, as the Dashboard is allowed to see it.
 *
 * The credential's **header** is here and its value is not: the Bank has to be
 * able to see how their own API is being addressed, and nobody has to be able to
 * read back what was sent in it.
 */
export interface Connector {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly endpoint: string;
  readonly gated: boolean;
  readonly parameters: readonly ConnectorParameter[];
  readonly credentialHeader: string;
  readonly credentialSetAt: string;
  readonly status: "active" | "retired";
  readonly registeredAt: string;
  readonly updatedAt: string;
  readonly retiredAt: string | null;
}

export interface ConnectorRegistry {
  readonly connectors: readonly Connector[];
  /** Where the Support Agent starts choosing badly. The screen says so. */
  readonly crowdedAt: number;
}

export const readConnectors = (session: Session): Promise<ConnectorRegistry> =>
  ask(session, "/dashboard/connectors", "the Connector registry");

export interface NewConnector {
  readonly name: string;
  /** **Untrusted model-facing text.** The form says so, where it is written. */
  readonly description: string;
  readonly endpoint: string;
  readonly gated: boolean;
  readonly parameters: readonly ConnectorParameter[];
  readonly credentialHeader: string;
  /** Entered once. This is the last time it is a value anybody holds. */
  readonly credential: string;
}

export const registerConnector = (
  session: Session,
  connector: NewConnector,
): Promise<{ connector: Connector }> =>
  ask(session, "/dashboard/connectors", "a new Connector", { method: "POST", body: connector });

/**
 * What may be changed afterwards. **Never the name** — it is what the Support
 * Agent calls and what every audit row about a dispatch names, so changing one
 * would silently re-point a history.
 */
export interface ConnectorChanges {
  readonly description?: string;
  readonly endpoint?: string;
  readonly gated?: boolean;
  readonly parameters?: readonly ConnectorParameter[];
  readonly credentialHeader?: string;
  /** Absent keeps the stored one; there is no way to see what it is. */
  readonly credential?: string;
}

export const changeConnector = (
  session: Session,
  connectorId: string,
  changes: ConnectorChanges,
): Promise<{ connector: Connector }> =>
  ask(session, `/dashboard/connectors/${encodeURIComponent(connectorId)}`, "a Connector change", {
    method: "PUT",
    body: changes,
  });

/** Retired rather than deleted: the audit rows about it still have to read. */
export const retireConnector = (
  session: Session,
  connectorId: string,
): Promise<{ connector: Connector }> =>
  ask(
    session,
    `/dashboard/connectors/${encodeURIComponent(connectorId)}/retire`,
    "a Connector retirement",
    { method: "POST" },
  );

/**
 * What the boxes on the form mean, in the one place both actions read them.
 *
 * Here rather than in the action file so it can be tested, and it is tested
 * because of what got through review the first time: **an unchecked box submits
 * nothing at all**, so `form.get("gated") !== "off"` read every absent box as
 * ticked and made Gated impossible to turn off. A form that quietly ignores what
 * somebody typed into it is worse than one that refuses them.
 */
export const registrationFrom = (form: FormData): NewConnector => ({
  name: text(form, "name"),
  description: text(form, "description"),
  endpoint: text(form, "endpoint"),
  gated: form.get("gated") === "on",
  parameters: parametersFrom(form),
  credentialHeader: text(form, "credentialHeader") || "authorization",
  // Never trimmed. A credential is a secret somebody pasted, and the platform
  // does not get to decide that a space in it was a mistake.
  credential: String(form.get("credential") ?? ""),
});

/**
 * The same fields on the way back in, minus the name, plus the rule about the
 * credential: **an empty box means leave the stored one alone**, because there
 * is nothing to compare it against and no way to read it back.
 */
export const changesFrom = (form: FormData): ConnectorChanges => {
  const credential = String(form.get("credential") ?? "");
  const registration = registrationFrom(form);

  return {
    description: registration.description,
    endpoint: registration.endpoint,
    gated: registration.gated,
    parameters: registration.parameters,
    credentialHeader: registration.credentialHeader,
    ...(credential.length > 0 ? { credential } : {}),
  };
};

const text = (form: FormData, name: string): string => String(form.get(name) ?? "").trim();

/** The field names the parameter rows carry, so the page and the action agree. */
export const parameterField = (
  index: number,
  part: "name" | "type" | "required" | "description",
): string => `parameter.${index}.${part}`;

/** How many parameter rows the form offers. The Middleware refuses more. */
export const PARAMETER_ROWS = 6;

/**
 * Reads the repeating parameter group back off a submitted form.
 *
 * A row with no name is an empty row somebody skipped rather than a mistake, so
 * it is dropped here. Everything else — a name that is not a field name, a
 * parameter that names the Customer, more than the Middleware allows — is
 * refused on the far side, where the rule lives.
 */
export const parametersFrom = (form: FormData): readonly ConnectorParameter[] =>
  Array.from({ length: PARAMETER_ROWS }, (_, index) => index)
    .map((index) => ({
      name: String(form.get(parameterField(index, "name")) ?? "").trim(),
      type: typeFrom(form.get(parameterField(index, "type"))),
      required: form.get(parameterField(index, "required")) === "on",
      description: String(form.get(parameterField(index, "description")) ?? "").trim(),
    }))
    .filter((parameter) => parameter.name.length > 0);

/**
 * Anything unrecognised is read as text, which is the type that coerces least.
 *
 * `unknown` rather than `FormDataEntryValue`, which is a DOM-only alias: this
 * module is imported by a `*.test.ts` that compiles under the workspace's Node
 * types, and the field is a form value nobody should be narrowing by its type
 * anyway.
 */
const typeFrom = (value: unknown): ConnectorParameterType =>
  value === "number" || value === "boolean" ? value : "string";
