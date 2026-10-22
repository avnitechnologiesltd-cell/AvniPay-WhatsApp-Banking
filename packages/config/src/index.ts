import { config as loadDotenvFile } from "dotenv";
import { z } from "zod";

import {
  baseUrl,
  bucketName,
  claimIdleMinutes,
  decoySecret,
  dormancyDays,
  encryptionKey,
  keyPath,
  nubanBankCode,
  optionalValue,
  parseEnvironment,
  port,
  requiredValue,
  retentionDays,
  retrievalBudgetTokens,
  sharedConfigFrom,
  sharedShape,
  type RawEnvironment,
  type SharedConfig,
} from "./values";

export { ConfigurationError } from "./values";
export type { Environment, LogLevel, SharedConfig } from "./values";

/**
 * Where a Customer's attachments live, as each deployable is told it.
 *
 * The endpoint, the bucket and the region are the same three values in both;
 * **the credentials are deliberately two different keys**, exactly as the two
 * database URLs are. The Platform's is write-only and the Middleware's is
 * read-only at the bucket policy, and naming them apart is what stops a
 * deployment quietly handing one credential to both and making that policy the
 * only thing between the prompt-injection surface and a Customer's documents.
 */
export interface AttachmentStoreConfig {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

const attachmentStoreShape = {
  ATTACHMENT_STORE_ENDPOINT: baseUrl,
  ATTACHMENT_STORE_BUCKET: bucketName,
  ATTACHMENT_STORE_REGION: requiredValue,
} as const;

/**
 * The one place in the workspace that reads `process.env`. Everything else
 * takes a configuration object, which is what lets a test point every external
 * base URL at an arbitrary address without a production seam existing for it.
 */
const processEnvironment = (): RawEnvironment => {
  loadDotenvFile({ override: false });
  return process.env;
};

// --- The database, for the migration step ------------------------------------

const databaseShape = z.object({
  ...sharedShape,
  DATABASE_URL: requiredValue,
  // The migration step reads all three, and it is the only thing that does.
  // The two below are not its connection — they are who it grants to, because
  // the login a deployable connects as is the login the grant model applies to
  // and there is no second key that could disagree with it.
  MIDDLEWARE_DATABASE_URL: requiredValue,
  PLATFORM_DATABASE_URL: requiredValue,
});

export interface DatabaseConfig extends SharedConfig {
  readonly databaseUrl: string;
  /** Not connected with here. Granted to — see `@avni/db`'s `roles.ts`. */
  readonly middlewareDatabaseUrl: string;
  /** Not connected with here. Granted to — see `@avni/db`'s `roles.ts`. */
  readonly platformDatabaseUrl: string;
}

/**
 * What the explicit migration step needs, and nothing else.
 *
 * `DATABASE_URL` is the owning credential and belongs to this step alone. The
 * Middleware and the Platform each read their own — see the note on
 * `MIDDLEWARE_DATABASE_URL` below — and the step applies the grants that make
 * those two logins mean different things.
 */
export const loadDatabaseConfig = (
  env: RawEnvironment = processEnvironment(),
): DatabaseConfig => {
  const raw = parseEnvironment(databaseShape, env);
  return {
    ...sharedConfigFrom(raw),
    databaseUrl: raw.DATABASE_URL,
    middlewareDatabaseUrl: raw.MIDDLEWARE_DATABASE_URL,
    platformDatabaseUrl: raw.PLATFORM_DATABASE_URL,
  };
};

// --- Middleware --------------------------------------------------------------

const middlewareShape = z.object({
  ...sharedShape,
  // Deliberately not the same key the Platform reads. The Middleware holds the
  // Binding and the hashed Transaction PIN; the Platform is the prompt-injection
  // surface and must hold none of it (ADR-0006). One shared credential would
  // make that boundary reachable with a SELECT, so the two are separate keys
  // from the first day rather than after there is something to steal.
  //
  // Splitting the *credential* was ticket 24. The grants that make the split
  // mean something — the Platform's role denied the Middleware's tables — are
  // applied by the migration step, in `@avni/db`'s `roles.ts`.
  MIDDLEWARE_DATABASE_URL: requiredValue,
  MIDDLEWARE_PORT: port,
  MIDDLEWARE_PUBLIC_BASE_URL: baseUrl,
  // Where a handset reaches the **Platform**, which is what a Snippet pasted
  // into the Bank's mobile application fetches the Widget from
  // (ADR-0011). The Middleware needs it because the Middleware is what
  // generates the Snippet, and it is a different address from
  // `MIDDLEWARE_BASE_URL`: that one is reachable between containers, this one
  // has to be reachable from a Customer's phone.
  PLATFORM_PUBLIC_BASE_URL: baseUrl,

  // The key the in-app chat signing secrets and every registered Connector's
  // credential are sealed under. Never in Postgres beside the ciphertext — see
  // values.ts.
  CREDENTIAL_ENCRYPTION_KEY: encryptionKey,

  INSTITUTION_API_BASE: baseUrl,
  INSTITUTION_API_KEY: requiredValue,
  INSTITUTION_CODE: requiredValue,
  BANK_CODE: requiredValue,
  // The Bank's own name, as a Customer would say it and as the Confirmation
  // screen shows it. Configuration because the deployment is the Bank's and the
  // development one is not theirs — and because a transfer is routed intra- or
  // inter-bank from whether the bank the Customer named is this one.
  BANK_NAME: requiredValue,
  THIRD_PARTY_API_BASE: baseUrl,
  BANKONE_PRODUCT_CODE: requiredValue,
  BANKONE_OFFICER_CODE: requiredValue,

  WHATSAPP_API_URL: baseUrl,
  WHATSAPP_API_TOKEN: requiredValue,
  WHATSAPP_VERIFY_TOKEN: requiredValue,
  WHATSAPP_PHONE_NUMBER_ID: requiredValue,
  // Verifies X-Hub-Signature-256 on the Flows endpoint, the Middleware's one
  // inbound path from the public internet.
  //
  // **Optional, and leaving it out turns the check off.** Meta recommends
  // verification and does not require it — a Flow works without it, which is
  // how the prior art runs. Absent, this endpoint accepts anything that
  // decrypts with the Flows private key, so the key becomes the only thing
  // standing in front of a surface that takes the Transaction PIN.
  //
  // Blank rather than missing means the same thing, because an operator who
  // clears the value has said the same as one who deleted the line. Whichever
  // it is, the Middleware says so loudly at boot — see `flowSignatureNotice`.
  WHATSAPP_APP_SECRET: optionalValue,
  WA_FLOW_PRIVATE_KEY_PATH: keyPath,
  WA_FLOW_PASSPHRASE: requiredValue,
  WA_SEND_MONEY_FLOW_ID: requiredValue,
  WA_SET_PIN_FLOW_ID: requiredValue,
  // Enrollment, renewal and a forgotten-PIN reset are one published Flow: they
  // are the same three screens with a different first step, and the Middleware
  // decides which walk a Customer is on rather than the Flow id doing it.
  WA_ENROLLMENT_FLOW_ID: requiredValue,

  BANK_IDENTITY_API_BASE: baseUrl,
  BANK_IDENTITY_API_KEY: requiredValue,

  // --- Enrollment ------------------------------------------------------------
  // The three-digit CBN code the NUBAN check digit is computed over, the key
  // that makes the decoy destinations unguessable, and the dormancy window a
  // Binding expires on. See values.ts for why each is here rather than inline.
  NUBAN_BANK_CODE: nubanBankCode,
  ENROLLMENT_DECOY_SECRET: decoySecret,
  BINDING_DORMANCY_DAYS: dormancyDays,

  // The Bank's retention policy, recorded rather than enacted. See values.ts.
  AUDIT_RETENTION_DAYS: retentionDays,

  // --- Handoff and the Inbox -------------------------------------------------
  //
  // How long an Officer's claim survives their silence. The business hours and
  // the operations alert address are **not** here: the Bank edits those from the
  // Dashboard without a redeploy, and they live in `platform_settings`.
  HANDOFF_CLAIM_IDLE_MINUTES: claimIdleMinutes,

  // The one approved template, which reopens a WhatsApp conversation whose
  // 24-hour window shut before an Officer answered. Its name is WABA-scoped and
  // Meta approves it per account, so it is configuration in the same way a Flow
  // id is — and a late-resolved Handoff is now its only user.
  WA_REOPEN_TEMPLATE_NAME: requiredValue,
  WA_REOPEN_TEMPLATE_LANGUAGE: requiredValue,

  // --- The Library ----------------------------------------------------------
  //
  // How much Library text the Support Agent may be given per turn. A capacity
  // control sized against Groq's 250K TPM rather than its context window — see
  // values.ts, and note that prompt caching does not relieve it.
  LIBRARY_RETRIEVAL_BUDGET_TOKENS: retrievalBudgetTokens,

  // The attachment bucket, and **read plus write** on this side. The read is an
  // Officer opening a file a Customer sent; the write is an Administrator
  // uploading a Library document, which is bytes this deployable reads on
  // purpose. The asymmetry that matters is on the other side: the Platform's
  // credential is write-only and its type has no `get` at all.
  ...attachmentStoreShape,
  MIDDLEWARE_ATTACHMENT_STORE_ACCESS_KEY_ID: requiredValue,
  MIDDLEWARE_ATTACHMENT_STORE_SECRET_ACCESS_KEY: requiredValue,
});

export interface BankOneConfig {
  readonly webApiBaseUrl: string;
  readonly thirdPartyApiBaseUrl: string;
  readonly apiKey: string;
  readonly institutionCode: string;
  readonly bankCode: string;
  readonly productCode: string;
  readonly officerCode: string;
}

export interface WhatsAppConfig {
  readonly graphApiBaseUrl: string;
  readonly apiToken: string;
  readonly verifyToken: string;
  readonly phoneNumberId: string;
  /**
   * Absent when the deployment has chosen not to verify signatures on the
   * Flows endpoint. Optional in the type, so no caller can forget the case.
   */
  readonly appSecret: string | undefined;
  readonly flows: {
    readonly privateKeyPath: string;
    readonly passphrase: string;
    readonly sendMoneyFlowId: string;
    readonly setPinFlowId: string;
    readonly enrollmentFlowId: string;
  };
  /**
   * The approved template that reopens a conversation past the 24-hour window.
   * One template, one user: a Handoff resolved after the window shut.
   */
  readonly reopenTemplate: { readonly name: string; readonly language: string };
}

export interface MiddlewareConfig extends SharedConfig {
  readonly databaseUrl: string;
  readonly port: number;
  readonly publicBaseUrl: string;
  /** Where a handset reaches the Platform, and therefore the Widget. */
  readonly platformPublicBaseUrl: string;
  /**
   * 32 bytes. What the in-app chat signing secrets and the Connector
   * credentials are sealed under — everything the Middleware must be able to
   * read back, and nothing it must not.
   */
  readonly credentialEncryptionKey: string;
  /** The Bank's own name, as the Confirmation screen shows it. */
  readonly bankName: string;
  readonly bankOne: BankOneConfig;
  readonly whatsapp: WhatsAppConfig;
  readonly bankIdentity: { readonly baseUrl: string; readonly apiKey: string };
  readonly handoff: {
    /** Minutes of Officer silence after which a claim returns to the queue. */
    readonly claimIdleMinutes: number;
  };
  /**
   * Read **and** write. The read serves a Customer's attachment to an Officer;
   * the write stores an Administrator's Library upload under `library/`.
   */
  readonly attachments: AttachmentStoreConfig;
  readonly library: {
    /** Tokens of Library text the Support Agent may be given per turn. */
    readonly retrievalBudgetTokens: number;
  };
  readonly enrollment: {
    /** Three digits. The NUBAN check digit is computed over it. */
    readonly nubanBankCode: string;
    /** Keys the decoy destinations, so they are deterministic but not derivable. */
    readonly decoySecret: string;
    /** Days without Customer-initiated contact before a Binding is dormant. */
    readonly bindingDormancyDays: number;
  };
  /** Days the Bank keeps audit rows. `0` is forever, and is the default. */
  readonly auditRetentionDays: number;
}

export const loadMiddlewareConfig = (
  env: RawEnvironment = processEnvironment(),
): MiddlewareConfig => {
  const raw = parseEnvironment(middlewareShape, env);
  return {
    ...sharedConfigFrom(raw),
    databaseUrl: raw.MIDDLEWARE_DATABASE_URL,
    port: raw.MIDDLEWARE_PORT,
    publicBaseUrl: raw.MIDDLEWARE_PUBLIC_BASE_URL,
    platformPublicBaseUrl: raw.PLATFORM_PUBLIC_BASE_URL,
    credentialEncryptionKey: raw.CREDENTIAL_ENCRYPTION_KEY,
    bankName: raw.BANK_NAME,
    bankOne: {
      webApiBaseUrl: raw.INSTITUTION_API_BASE,
      thirdPartyApiBaseUrl: raw.THIRD_PARTY_API_BASE,
      apiKey: raw.INSTITUTION_API_KEY,
      institutionCode: raw.INSTITUTION_CODE,
      bankCode: raw.BANK_CODE,
      productCode: raw.BANKONE_PRODUCT_CODE,
      officerCode: raw.BANKONE_OFFICER_CODE,
    },
    whatsapp: {
      graphApiBaseUrl: raw.WHATSAPP_API_URL,
      apiToken: raw.WHATSAPP_API_TOKEN,
      verifyToken: raw.WHATSAPP_VERIFY_TOKEN,
      phoneNumberId: raw.WHATSAPP_PHONE_NUMBER_ID,
      appSecret: raw.WHATSAPP_APP_SECRET,
      flows: {
        privateKeyPath: raw.WA_FLOW_PRIVATE_KEY_PATH,
        passphrase: raw.WA_FLOW_PASSPHRASE,
        sendMoneyFlowId: raw.WA_SEND_MONEY_FLOW_ID,
        setPinFlowId: raw.WA_SET_PIN_FLOW_ID,
        enrollmentFlowId: raw.WA_ENROLLMENT_FLOW_ID,
      },
      reopenTemplate: {
        name: raw.WA_REOPEN_TEMPLATE_NAME,
        language: raw.WA_REOPEN_TEMPLATE_LANGUAGE,
      },
    },
    bankIdentity: {
      baseUrl: raw.BANK_IDENTITY_API_BASE,
      apiKey: raw.BANK_IDENTITY_API_KEY,
    },
    handoff: { claimIdleMinutes: raw.HANDOFF_CLAIM_IDLE_MINUTES },
    library: { retrievalBudgetTokens: raw.LIBRARY_RETRIEVAL_BUDGET_TOKENS },
    attachments: {
      endpoint: raw.ATTACHMENT_STORE_ENDPOINT,
      bucket: raw.ATTACHMENT_STORE_BUCKET,
      region: raw.ATTACHMENT_STORE_REGION,
      accessKeyId: raw.MIDDLEWARE_ATTACHMENT_STORE_ACCESS_KEY_ID,
      secretAccessKey: raw.MIDDLEWARE_ATTACHMENT_STORE_SECRET_ACCESS_KEY,
    },
    enrollment: {
      nubanBankCode: raw.NUBAN_BANK_CODE,
      decoySecret: raw.ENROLLMENT_DECOY_SECRET,
      bindingDormancyDays: raw.BINDING_DORMANCY_DAYS,
    },
    auditRetentionDays: raw.AUDIT_RETENTION_DAYS,
  };
};

// --- Platform ----------------------------------------------------------------

const platformShape = z.object({
  ...sharedShape,
  PLATFORM_DATABASE_URL: requiredValue,
  PLATFORM_PORT: port,
  MIDDLEWARE_BASE_URL: baseUrl,

  // The Platform receives the webhook and sends ordinary replies, so it holds
  // the Graph credentials. It does **not** hold the Flows private key: an
  // authorisation surface posts to the Middleware and terminates there
  // (ADR-0007), so the key that opens one never enters this deployable.
  WHATSAPP_API_URL: baseUrl,
  WHATSAPP_API_TOKEN: requiredValue,
  WHATSAPP_VERIFY_TOKEN: requiredValue,
  WHATSAPP_PHONE_NUMBER_ID: requiredValue,

  // The Bank's own name and where somebody who does not bank there yet is sent.
  // The Platform greets an unknown number before any model call, so it needs
  // both — and neither is a literal, because the greeting is the first thing
  // every Customer reads and the Bank's name is not ours to hardcode.
  BANK_NAME: requiredValue,
  BANK_SIGNUP_URL: baseUrl,

  GROQ_API_BASE: baseUrl,
  GROQ_API_KEY: requiredValue,
  GROQ_INTENT_MODEL: requiredValue,
  GROQ_SUPPORT_MODEL: requiredValue,

  // **Write-only** against the attachment bucket. The Platform moves bytes from
  // WhatsApp's media API into object storage without opening them; a credential
  // that could read one back would put a Customer's documents inside the
  // prompt-injection surface, which is the whole reason they are stored
  // somewhere else in the first place.
  ...attachmentStoreShape,
  PLATFORM_ATTACHMENT_STORE_ACCESS_KEY_ID: requiredValue,
  PLATFORM_ATTACHMENT_STORE_SECRET_ACCESS_KEY: requiredValue,
});

export interface PlatformConfig extends SharedConfig {
  readonly databaseUrl: string;
  /** The Bank's own name, as the greeting says it. */
  readonly bankName: string;
  /** Where somebody who does not bank here yet is sent to open an account. */
  readonly bankSignupUrl: string;
  readonly port: number;
  readonly middlewareBaseUrl: string;
  readonly whatsappVerifyToken: string;
  readonly whatsapp: {
    readonly graphApiBaseUrl: string;
    readonly apiToken: string;
    readonly phoneNumberId: string;
  };
  readonly groq: {
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly intentModel: string;
    readonly supportModel: string;
  };
  /** Write-only. There is no code path in the Platform that reads one back. */
  readonly attachments: AttachmentStoreConfig;
}

export const loadPlatformConfig = (
  env: RawEnvironment = processEnvironment(),
): PlatformConfig => {
  const raw = parseEnvironment(platformShape, env);
  return {
    ...sharedConfigFrom(raw),
    databaseUrl: raw.PLATFORM_DATABASE_URL,
    bankName: raw.BANK_NAME,
    bankSignupUrl: raw.BANK_SIGNUP_URL,
    port: raw.PLATFORM_PORT,
    middlewareBaseUrl: raw.MIDDLEWARE_BASE_URL,
    whatsappVerifyToken: raw.WHATSAPP_VERIFY_TOKEN,
    whatsapp: {
      graphApiBaseUrl: raw.WHATSAPP_API_URL,
      apiToken: raw.WHATSAPP_API_TOKEN,
      phoneNumberId: raw.WHATSAPP_PHONE_NUMBER_ID,
    },
    groq: {
      baseUrl: raw.GROQ_API_BASE,
      apiKey: raw.GROQ_API_KEY,
      intentModel: raw.GROQ_INTENT_MODEL,
      supportModel: raw.GROQ_SUPPORT_MODEL,
    },
    attachments: {
      endpoint: raw.ATTACHMENT_STORE_ENDPOINT,
      bucket: raw.ATTACHMENT_STORE_BUCKET,
      region: raw.ATTACHMENT_STORE_REGION,
      accessKeyId: raw.PLATFORM_ATTACHMENT_STORE_ACCESS_KEY_ID,
      secretAccessKey: raw.PLATFORM_ATTACHMENT_STORE_SECRET_ACCESS_KEY,
    },
  };
};

// --- Dashboard ---------------------------------------------------------------

const dashboardShape = z.object({
  ...sharedShape,
  DASHBOARD_PORT: port,
  MIDDLEWARE_BASE_URL: baseUrl,
  PLATFORM_BASE_URL: baseUrl,
});

export interface DashboardConfig extends SharedConfig {
  readonly port: number;
  readonly middlewareBaseUrl: string;
  readonly platformBaseUrl: string;
}

export const loadDashboardConfig = (
  env: RawEnvironment = processEnvironment(),
): DashboardConfig => {
  const raw = parseEnvironment(dashboardShape, env);
  return {
    ...sharedConfigFrom(raw),
    port: raw.DASHBOARD_PORT,
    middlewareBaseUrl: raw.MIDDLEWARE_BASE_URL,
    platformBaseUrl: raw.PLATFORM_BASE_URL,
  };
};

export type { RawEnvironment };
