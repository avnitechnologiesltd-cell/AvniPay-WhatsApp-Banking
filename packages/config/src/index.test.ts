import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  loadDashboardConfig,
  loadDatabaseConfig,
  loadMiddlewareConfig,
  loadPlatformConfig,
} from "./index";

const middlewareEnv = (): Record<string, string> => ({
  MIDDLEWARE_DATABASE_URL: "postgres://avni_middleware:pw@localhost:5432/avni",
  MIDDLEWARE_PORT: "3001",
  MIDDLEWARE_PUBLIC_BASE_URL: "https://middleware.example",
  PLATFORM_PUBLIC_BASE_URL: "https://app.bank.example",
  CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  INSTITUTION_API_BASE: "https://bankone.example/BankOneWebAPI",
  INSTITUTION_API_KEY: "auth-token",
  INSTITUTION_CODE: "100999",
  BANK_CODE: "090999",
  BANK_NAME: "Example MFB",
  THIRD_PARTY_API_BASE: "https://bankone.example/thirdpartyapiservice/apiservice",
  BANKONE_PRODUCT_CODE: "201",
  BANKONE_OFFICER_CODE: "OFF-1",
  WHATSAPP_API_URL: "https://graph.facebook.com/v19.0",
  WHATSAPP_API_TOKEN: "graph-token",
  WHATSAPP_VERIFY_TOKEN: "verify-token",
  WHATSAPP_PHONE_NUMBER_ID: "10987654321",
  WHATSAPP_APP_SECRET: "app-secret",
  WA_FLOW_PRIVATE_KEY_PATH: "./secrets/whatsapp-flow-private.pem",
  WA_FLOW_PASSPHRASE: "passphrase",
  WA_SEND_MONEY_FLOW_ID: "111222333",
  WA_SET_PIN_FLOW_ID: "444555666",
  WA_ENROLLMENT_FLOW_ID: "777888999",
  BANK_IDENTITY_API_BASE: "https://identity.example",
  BANK_IDENTITY_API_KEY: "identity-key",
  NUBAN_BANK_CODE: "090",
  ENROLLMENT_DECOY_SECRET: "a-long-enough-decoy-secret",
  WA_REOPEN_TEMPLATE_NAME: "support_update_available",
  WA_REOPEN_TEMPLATE_LANGUAGE: "en",
  ATTACHMENT_STORE_ENDPOINT: "https://objects.bank.example",
  ATTACHMENT_STORE_BUCKET: "avni-attachments",
  ATTACHMENT_STORE_REGION: "us-east-1",
  MIDDLEWARE_ATTACHMENT_STORE_ACCESS_KEY_ID: "middleware-reads",
  MIDDLEWARE_ATTACHMENT_STORE_SECRET_ACCESS_KEY: "middleware-reads-secret",
});

const platformEnv = (): Record<string, string> => ({
  PLATFORM_DATABASE_URL: "postgres://avni_platform:pw@localhost:5432/avni",
  PLATFORM_PORT: "3002",
  MIDDLEWARE_BASE_URL: "http://middleware:3001",
  BANK_NAME: "Example MFB",
  BANK_SIGNUP_URL: "https://bank.example/open-an-account",
  WHATSAPP_API_URL: "https://graph.facebook.com/v19.0",
  WHATSAPP_API_TOKEN: "graph-token",
  WHATSAPP_VERIFY_TOKEN: "verify-token",
  WHATSAPP_PHONE_NUMBER_ID: "10987654321",
  GROQ_API_BASE: "https://api.groq.com/openai/v1",
  GROQ_API_KEY: "groq-key",
  GROQ_INTENT_MODEL: "openai/gpt-oss-20b",
  GROQ_SUPPORT_MODEL: "openai/gpt-oss-120b",
  ATTACHMENT_STORE_ENDPOINT: "https://objects.bank.example",
  ATTACHMENT_STORE_BUCKET: "avni-attachments",
  ATTACHMENT_STORE_REGION: "us-east-1",
  PLATFORM_ATTACHMENT_STORE_ACCESS_KEY_ID: "platform-writes",
  PLATFORM_ATTACHMENT_STORE_SECRET_ACCESS_KEY: "platform-writes-secret",
});

const dashboardEnv = (): Record<string, string> => ({
  DASHBOARD_PORT: "3003",
  MIDDLEWARE_BASE_URL: "http://middleware:3001",
  PLATFORM_BASE_URL: "http://platform:3002",
});

describe("loadMiddlewareConfig", () => {
  it("reads every BankOne, WhatsApp and identity value from the environment", () => {
    const config = loadMiddlewareConfig(middlewareEnv());

    expect(config.bankOne).toEqual({
      webApiBaseUrl: "https://bankone.example/BankOneWebAPI",
      thirdPartyApiBaseUrl: "https://bankone.example/thirdpartyapiservice/apiservice",
      apiKey: "auth-token",
      institutionCode: "100999",
      bankCode: "090999",
      productCode: "201",
      officerCode: "OFF-1",
    });
    // The Bank's own name, which the Confirmation screen shows and which
    // decides whether a transfer is intra- or inter-bank.
    expect(config.bankName).toBe("Example MFB");
    expect(config.whatsapp.graphApiBaseUrl).toBe("https://graph.facebook.com/v19.0");
    expect(config.whatsapp.phoneNumberId).toBe("10987654321");
    expect(config.whatsapp.flows.sendMoneyFlowId).toBe("111222333");
    expect(config.whatsapp.flows.setPinFlowId).toBe("444555666");
    expect(config.whatsapp.flows.enrollmentFlowId).toBe("777888999");
    expect(config.bankIdentity.baseUrl).toBe("https://identity.example");
  });

  it("takes the NUBAN check-digit bank code separately from the NIBSS one", () => {
    // Three digits and six digits, and they are not the same number. Computing
    // the check digit over the NIBSS code would reject every real Customer, so
    // the two are separate keys rather than one value used twice.
    const config = loadMiddlewareConfig(middlewareEnv());

    expect(config.enrollment.nubanBankCode).toBe("090");
    expect(config.bankOne.bankCode).toBe("090999");
  });

  it("refuses a NUBAN bank code that is not three digits", () => {
    for (const wrong of ["090999", "90", "abc", ""]) {
      expect(() =>
        loadMiddlewareConfig({ ...middlewareEnv(), NUBAN_BANK_CODE: wrong }),
      ).toThrow(ConfigurationError);
    }
  });

  it("defaults the Binding dormancy window to ninety days, and lets it be set", () => {
    expect(loadMiddlewareConfig(middlewareEnv()).enrollment.bindingDormancyDays).toBe(90);
    expect(
      loadMiddlewareConfig({ ...middlewareEnv(), BINDING_DORMANCY_DAYS: "60" }).enrollment
        .bindingDormancyDays,
    ).toBe(60);
  });

  it("refuses a decoy secret short enough to guess", () => {
    // Deterministic decoys are only worth having if they are not derivable, and
    // the key is the whole of what makes them so.
    expect(() =>
      loadMiddlewareConfig({ ...middlewareEnv(), ENROLLMENT_DECOY_SECRET: "short" }),
    ).toThrow(ConfigurationError);
  });

  it("refuses an encryption key that is not 32 bytes", () => {
    // A short key silently becoming an AES-256 key is a weakening nobody would
    // notice, so it is refused at boot rather than stretched.
    for (const key of ["", "short", Buffer.alloc(16, 1).toString("base64")]) {
      expect(() =>
        loadMiddlewareConfig({ ...middlewareEnv(), CREDENTIAL_ENCRYPTION_KEY: key }),
      ).toThrow(ConfigurationError);
    }
  });

  it("takes the Platform's public address separately from the Middleware's", () => {
    // Where a handset fetches the Widget from is not where a Flow posts to, and
    // the Snippet the Bank pastes into their application carries the first.
    const config = loadMiddlewareConfig(middlewareEnv());

    expect(config.platformPublicBaseUrl).toBe("https://app.bank.example");
    expect(config.platformPublicBaseUrl).not.toBe(config.publicBaseUrl);
  });

  it("points every external base URL wherever configuration says", () => {
    const config = loadMiddlewareConfig({
      ...middlewareEnv(),
      INSTITUTION_API_BASE: "http://127.0.0.1:9101",
      THIRD_PARTY_API_BASE: "http://127.0.0.1:9102",
      WHATSAPP_API_URL: "http://127.0.0.1:9103",
      BANK_IDENTITY_API_BASE: "http://127.0.0.1:9104",
    });

    expect(config.bankOne.webApiBaseUrl).toBe("http://127.0.0.1:9101");
    expect(config.bankOne.thirdPartyApiBaseUrl).toBe("http://127.0.0.1:9102");
    expect(config.whatsapp.graphApiBaseUrl).toBe("http://127.0.0.1:9103");
    expect(config.bankIdentity.baseUrl).toBe("http://127.0.0.1:9104");
  });

  it("names every missing key at once rather than one per restart", () => {
    const env = middlewareEnv();
    delete env["INSTITUTION_CODE"];
    delete env["BANK_CODE"];
    delete env["WA_SEND_MONEY_FLOW_ID"];

    let thrown: unknown;
    try {
      loadMiddlewareConfig(env);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigurationError);
    const message = (thrown as ConfigurationError).message;
    expect(message).toContain("INSTITUTION_CODE");
    expect(message).toContain("BANK_CODE");
    expect(message).toContain("WA_SEND_MONEY_FLOW_ID");
  });

  it("refuses key material pasted in place of a key path", () => {
    const env = middlewareEnv();
    env["WA_FLOW_PRIVATE_KEY_PATH"] = "-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIF...";

    expect(() => loadMiddlewareConfig(env)).toThrowError(/WA_FLOW_PRIVATE_KEY_PATH.*path/is);
  });

  it("refuses a blank required value as firmly as a missing one", () => {
    const env = middlewareEnv();
    env["INSTITUTION_API_KEY"] = "   ";

    expect(() => loadMiddlewareConfig(env)).toThrowError(/INSTITUTION_API_KEY/);
  });

  it("refuses a base URL that is not a URL", () => {
    const env = middlewareEnv();
    env["INSTITUTION_API_BASE"] = "staging.mybankone.com";

    expect(() => loadMiddlewareConfig(env)).toThrowError(/INSTITUTION_API_BASE/);
  });
});

describe("loadPlatformConfig", () => {
  it("reads the Groq models and the Middleware address from the environment", () => {
    const config = loadPlatformConfig(platformEnv());

    expect(config.groq.intentModel).toBe("openai/gpt-oss-20b");
    expect(config.groq.supportModel).toBe("openai/gpt-oss-120b");
    expect(config.groq.baseUrl).toBe("https://api.groq.com/openai/v1");
    expect(config.middlewareBaseUrl).toBe("http://middleware:3001");
  });

  it("points Groq and the Middleware wherever configuration says", () => {
    const config = loadPlatformConfig({
      ...platformEnv(),
      GROQ_API_BASE: "http://127.0.0.1:9201",
      MIDDLEWARE_BASE_URL: "http://127.0.0.1:9202",
    });

    expect(config.groq.baseUrl).toBe("http://127.0.0.1:9201");
    expect(config.middlewareBaseUrl).toBe("http://127.0.0.1:9202");
  });

  it("carries no BankOne credential and no route to it", () => {
    // ADR-0006. The Platform holds the Graph credentials, because it receives
    // the webhook and sends ordinary replies — but nothing that reads or moves
    // money, and not the Flows private key that opens an authorisation surface.
    const config = loadPlatformConfig(platformEnv());
    const serialised = JSON.stringify(config);

    expect(serialised).not.toContain("bankOne");
    expect(serialised).not.toContain("institutionCode");
    expect(config).not.toHaveProperty("bankIdentity");
    expect(serialised).not.toContain("privateKeyPath");
    expect(serialised).not.toContain("Flow");
  });
});

describe("the database credential", () => {
  it("is a different key for the Middleware and the Platform", () => {
    // ADR-0006: the Middleware holds the Binding and the hashed Transaction PIN
    // and the Platform holds none of it. One shared credential would put that
    // boundary one SELECT away from the prompt-injection surface.
    const middleware = loadMiddlewareConfig(middlewareEnv());
    const platform = loadPlatformConfig(platformEnv());

    expect(middleware.databaseUrl).not.toBe(platform.databaseUrl);
  });

  it("refuses a Middleware handed only the Platform's credential", () => {
    const env = middlewareEnv();
    delete env["MIDDLEWARE_DATABASE_URL"];
    env["PLATFORM_DATABASE_URL"] = "postgres://avni_platform:pw@localhost:5432/avni";

    expect(() => loadMiddlewareConfig(env)).toThrowError(/MIDDLEWARE_DATABASE_URL/);
  });

  it("keeps the owning credential to the migration step alone", () => {
    // DATABASE_URL owns the schema. Neither deployable may read it.
    expect(() =>
      loadPlatformConfig({
        ...platformEnv(),
        PLATFORM_DATABASE_URL: undefined,
        DATABASE_URL: "postgres://avni:avni@localhost:5432/avni",
      } as Record<string, string | undefined>),
    ).toThrowError(/PLATFORM_DATABASE_URL/);
  });
});

describe("loadDatabaseConfig", () => {
  const databaseEnv = (): Record<string, string | undefined> => ({
    DATABASE_URL: "postgres://avni:owner@postgres:5432/avni",
    MIDDLEWARE_DATABASE_URL: "postgres://avni_middleware:mw@postgres:5432/avni",
    PLATFORM_DATABASE_URL: "postgres://avni_platform:pf@postgres:5432/avni",
  });

  it("reads all three, because the step grants to two of them", () => {
    const config = loadDatabaseConfig(databaseEnv());

    expect(config.databaseUrl).toBe("postgres://avni:owner@postgres:5432/avni");
    expect(config.middlewareDatabaseUrl).toBe("postgres://avni_middleware:mw@postgres:5432/avni");
    expect(config.platformDatabaseUrl).toBe("postgres://avni_platform:pf@postgres:5432/avni");
  });

  it("refuses a migration step that does not know who to grant to", () => {
    const env = databaseEnv();
    delete env["PLATFORM_DATABASE_URL"];

    expect(() => loadDatabaseConfig(env)).toThrowError(/PLATFORM_DATABASE_URL/);
  });
});

describe("loadDashboardConfig", () => {
  it("reads both service addresses from the environment", () => {
    const config = loadDashboardConfig(dashboardEnv());

    expect(config.middlewareBaseUrl).toBe("http://middleware:3001");
    expect(config.platformBaseUrl).toBe("http://platform:3002");
  });
});

describe("shared values", () => {
  it("defaults the log level and the environment name", () => {
    const config = loadPlatformConfig(platformEnv());

    expect(config.environment).toBe("development");
    expect(config.logLevel).toBe("info");
  });

  it("refuses an environment name outside the two we deploy", () => {
    expect(() => loadPlatformConfig({ ...platformEnv(), DEPLOYMENT_ENVIRONMENT: "preprod" })).toThrowError(
      /DEPLOYMENT_ENVIRONMENT/,
    );
  });

  it("refuses a port that is not a port", () => {
    expect(() => loadPlatformConfig({ ...platformEnv(), PLATFORM_PORT: "0" })).toThrowError(
      /PLATFORM_PORT/,
    );
  });
});
