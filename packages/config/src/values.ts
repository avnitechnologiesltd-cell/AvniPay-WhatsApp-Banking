import { z } from "zod";

/**
 * Thrown when the environment does not describe a runnable deployment. Carries
 * every offending key at once: an operator restarting a container to discover
 * the next missing value is a bad afternoon we can prevent here.
 */
export class ConfigurationError extends Error {
  public override readonly name = "ConfigurationError";

  public constructor(public readonly problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
}

/** A value that must be present and non-blank. */
export const requiredValue = z.string().trim().min(1, "must not be blank");

/**
 * An external base URL. Every one of these is configuration rather than a
 * constant, because the Bank's BankOne tenancy and WhatsApp account are not the
 * development ones, and because a test points them at an arbitrary address.
 */
export const baseUrl = z
  .string()
  .trim()
  .min(1, "must not be blank")
  .url("must be an absolute URL, scheme included");

/**
 * A path to key material on disk. Never the material itself — `.env` holds
 * paths and the `.pem` files are mounted beside it, so a value that looks like
 * a key is an operator mistake worth refusing loudly.
 */
export const keyPath = requiredValue.refine(
  (value) => !value.includes("-----BEGIN"),
  "must be a path to a key file, not the contents of one",
);

export const port = z.coerce
  .number({ invalid_type_error: "must be a number" })
  .int("must be a whole number")
  .min(1, "must be a usable port")
  .max(65535, "must be a usable port");

/**
 * Staging runs on our infrastructure, production on the Bank's. Nothing else.
 *
 * Deliberately not `NODE_ENV`: that one belongs to Node and to Next, which
 * force it to `production` inside a container, and which would then be deciding
 * what the Bank's deployment is called. Nothing branches on this value — it is
 * for saying which deployment a log line or a health body came from.
 */
export const deploymentEnvironment = z
  .enum(["development", "staging", "production"])
  .default("development");

export const logLevel = z
  .enum(["fatal", "error", "warn", "info", "debug", "trace"])
  .default("info");

/**
 * How long the Bank keeps audit rows, in days. `0` means forever.
 *
 * **The platform never deletes a row.** This records the Bank's policy so their
 * own archival tooling has one place to read it from, and so the number is not
 * folklore. Nothing in this codebase acts on it, and a test refuses any delete
 * against the audit table — the moment the platform prunes its own evidence,
 * the table stops being evidence.
 */
export const retentionDays = z.coerce
  .number({ invalid_type_error: "must be a number of days" })
  .int("must be a whole number of days")
  .min(0, "must not be negative — 0 means keep everything")
  .default(0);

/**
 * The Bank's **three-digit CBN code**, and deliberately not `BANK_CODE`, which
 * is the six-digit NIBSS institution code the transfer endpoints take.
 *
 * It exists for one purpose: a 10-digit NUBAN is nine serial digits plus a
 * check digit computed over `<3-digit bank code> + <9 serial digits>`, so the
 * local check that catches a mistyped account number before any call leaves the
 * platform cannot be computed without it. Three digits exactly, because the
 * weight vector has a fixed length and a value of the wrong shape would silently
 * turn the check into noise.
 */
export const nubanBankCode = requiredValue.regex(
  /^\d{3}$/,
  "must be the Bank's three-digit CBN code, not the six-digit NIBSS one",
);

/**
 * Keys the decoy destinations enrollment shows for an account the Bank does not
 * hold.
 *
 * The decoys must be **deterministic** — two probes of the same unknown account
 * that differed would themselves be the oracle enumeration resistance exists to
 * remove. But deterministic from the account number *alone* is worse: anyone who
 * can read this source could compute the decoys for any account offline and tell
 * a real destination list from a fabricated one at a glance. Keying the
 * derivation closes that, and costs nothing but this value.
 */
export const decoySecret = requiredValue.min(
  16,
  "must be at least 16 characters — it is what stops the decoys being computable",
);

/**
 * How long a Binding survives with no **Customer-initiated** contact, in days.
 *
 * Configuration rather than a constant because the real operator churn window
 * for a recycled Nigerian number is worth confirming and is cheap to change.
 * Ninety days is the settled starting value, not a finding.
 */
export const dormancyDays = z.coerce
  .number({ invalid_type_error: "must be a number of days" })
  .int("must be a whole number of days")
  .min(1, "must be at least a day")
  .default(90);

/**
 * The key everything the Middleware must be able to *read back* is encrypted
 * with — today the in-app chat signing secrets, and tomorrow the Connector
 * credentials (ticket 40).
 *
 * **One key, and it does not live in Postgres.** A database dump that carries
 * its own key is not encrypted, it is obfuscated — which is the whole of why
 * this is an environment value and why the deployment section of the spec names
 * it. Where it comes *from* is the Bank's infrastructure question
 * (ticket 23):
 * a managed secret store, or a file mounted beside the `.env`.
 *
 * Distinct from a password hash and a Transaction PIN, which are argon2id and
 * are never read back at all. A signing secret has to be recoverable, because
 * verifying an HMAC needs the secret itself — so this is the one class of thing
 * the Middleware holds that reversible encryption is the right answer for.
 *
 * 32 bytes, base64. Refused at any other length rather than stretched: a short
 * key silently becoming an AES-256 key is a weakening nobody would notice.
 */
export const encryptionKey = requiredValue.refine(
  (value) => decodedByteLength(value) === 32,
  "must be 32 bytes of base64 — generate one with: openssl rand -base64 32",
);

const decodedByteLength = (value: string): number => {
  try {
    return Buffer.from(value, "base64").byteLength;
  } catch {
    return 0;
  }
};

/**
 * How long a Support Officer's claim on a conversation survives their silence,
 * in minutes.
 *
 * **A claim that never expires is a conversation held hostage by somebody who
 * went home with it open**, which is the failure that actually happens — so this
 * has a value rather than being left to a Dashboard button nobody presses.
 * Configuration rather than a constant because it is a staffing judgement: a
 * bank with two Officers on a shift wants it shorter than one with twenty.
 */
export const claimIdleMinutes = z.coerce
  .number({ invalid_type_error: "must be a number of minutes" })
  .int("must be a whole number of minutes")
  .min(1, "must be at least a minute")
  .default(30);

/**
 * How much **Library** text the Support Agent may be given on one turn, in
 * tokens.
 *
 * **A capacity control, not a quality knob**, and the difference decides where
 * the number comes from. The binding constraint is Groq's 250K TPM rather than
 * the 131K context window: a Support Agent conversation already costs roughly
 * 25,000 cumulative input tokens across its turns, and anything in the preamble
 * multiplies against *every* turn of *every* conversation. A 40,000-token policy
 * set stuffed into context would leave the entire Bank about six Agent turns per
 * minute.
 *
 * Prompt caching does not relieve this. Groq prices a cached prefix at half, and
 * nothing documents cached tokens being discounted against **TPM** — so caching
 * answers the bill, which was never the problem at half a US cent per
 * conversation. Never size capacity on it.
 *
 * 8,000 is a **starting value rather than a finding**: it wants a real corpus and
 * the Bank has not supplied one yet. That is exactly why it is configuration.
 */
export const retrievalBudgetTokens = z.coerce
  .number({ invalid_type_error: "must be a number of tokens" })
  .int("must be a whole number of tokens")
  .min(500, "must leave room for a section — below this the Agent can cite nothing")
  .max(60_000, "must stay well inside the model's window and the Bank's throughput")
  .default(8_000);

/**
 * The object-store bucket a Customer's attachments are written to.
 *
 * Lowercase, digits, hyphens and dots — S3's own rule, checked here so a bucket
 * name that cannot be addressed fails at boot rather than on the first
 * Customer who photographs a receipt.
 */
export const bucketName = requiredValue.regex(
  /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
  "must be a valid S3 bucket name: lowercase letters, digits, dots and hyphens",
);

export const sharedShape = {
  DEPLOYMENT_ENVIRONMENT: deploymentEnvironment,
  LOG_LEVEL: logLevel,
} as const;

export type Environment = z.infer<typeof deploymentEnvironment>;
export type LogLevel = z.infer<typeof logLevel>;

export interface SharedConfig {
  readonly environment: Environment;
  readonly logLevel: LogLevel;
}

export type RawEnvironment = Record<string, string | undefined>;

/** Every deployable's config starts with these two; only the loaders spell it. */
export const sharedConfigFrom = (raw: {
  DEPLOYMENT_ENVIRONMENT: Environment;
  LOG_LEVEL: LogLevel;
}): SharedConfig => ({
  environment: raw.DEPLOYMENT_ENVIRONMENT,
  logLevel: raw.LOG_LEVEL,
});

/** Parses `env` against `schema`, collecting every problem before throwing. */
export const parseEnvironment = <T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
  env: RawEnvironment,
): z.infer<z.ZodObject<T>> => {
  const result = schema.safeParse(env);
  if (result.success) return result.data;

  const problems = result.error.issues.map((issue) => {
    const key = issue.path.join(".") || "(unknown key)";
    const detail = issue.message === "Required" ? "is required" : issue.message;
    return `${key} ${detail}`;
  });
  throw new ConfigurationError(problems);
};

/**
 * A value the deployment may leave out, normalised so that blank and missing
 * are one case.
 *
 * `undefined` rather than `""` for absent, because the difference between "not
 * configured" and "configured as empty" is one nobody can act on and every
 * reader would have to handle twice.
 */
export const optionalValue = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === undefined || value === "" ? undefined : value));
