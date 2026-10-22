import { randomBytes } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, createPool, readMigrations, type Pool } from "@avni/db";

import { AuthenticationService } from "./authentication";
import { AuditRepository } from "../audit/audit.repository";
import { runSetup, type SetupPrompts } from "./setup";
import { StaffRepository } from "./staff.repository";
import { generateTotpSecret, totp } from "./totp";

/**
 * The step that decides whether a fresh deployment is reachable at all.
 *
 * Tested as a function rather than by feeding a heredoc into `docker compose
 * run` — which is how the first attempt at verifying this silently proved
 * nothing, because readline never received the input and the run refused for
 * the wrong reason.
 */

const ADMIN_URL = process.env["TEST_DATABASE_URL"] ?? "postgres://avni:avni@localhost:5432/avni";
const PASSWORD = "a-long-enough-password";
const AT = 1_700_000_000_000;

let admin: Pool;
let databaseName: string;
let pool: Pool;
let staff: StaffRepository;

const withDatabase = (connectionString: string, name: string): string => {
  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  return url.toString();
};

/** A scripted operator: answers in order, and records what it was told. */
const anOperator = (
  answers: readonly string[],
  secret: string,
): SetupPrompts & { said: string[] } => {
  const said: string[] = [];
  let index = 0;

  return {
    said,
    ask: (question) => {
      said.push(question);
      return Promise.resolve(answers[index++] ?? "");
    },
    say: (line) => said.push(line),
    now: () => AT,
    newSecret: () => secret,
    issuer: "Example MFB",
  };
};

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await admin.query("select 1");
});

afterAll(async () => {
  await admin.end();
});

beforeEach(async () => {
  databaseName = `avni_setup_${randomBytes(6).toString("hex")}`;
  await admin.query(`create database ${databaseName}`);
  pool = createPool(withDatabase(ADMIN_URL, databaseName));
  await applyMigrations(pool, readMigrations());
  staff = new StaffRepository(pool);
});

afterEach(async () => {
  await pool.end();
  await admin.query(`drop database if exists ${databaseName} with (force)`);
});

const goodAnswers = (secret: string) => [
  "grace@bank.example",
  "Grace Hopper",
  PASSWORD,
  totp(secret, AT),
];

describe("the first Administrator", () => {
  it("is created, with MFA enrolled, and can then sign in", async () => {
    const secret = generateTotpSecret();
    const operator = anOperator(goodAnswers(secret), secret);

    const result = await runSetup(pool, operator);

    expect(result.outcome).toBe("created");
    // The point of the whole step: somebody can now get in, and nobody could
    // before.
    const auth = new AuthenticationService(staff, new AuditRepository(pool));
    const signIn = await auth.authenticate(
      {
        method: "password",
        email: "grace@bank.example",
        password: PASSWORD,
        totpCode: totp(secret, AT),
      },
      { now: new Date(AT) },
    );
    expect(signIn.outcome).toBe("signed_in");
  });

  it("is an Administrator, not a Support Officer", async () => {
    const secret = generateTotpSecret();
    await runSetup(pool, anOperator(goodAnswers(secret), secret));

    expect((await staff.findByEmail("grace@bank.example"))?.role).toBe("administrator");
  });

  it("shows a secret an authenticator app can scan", async () => {
    const secret = generateTotpSecret();
    const operator = anOperator(goodAnswers(secret), secret);

    await runSetup(pool, operator);

    expect(operator.said.join("\n")).toContain("otpauth://totp/");
    expect(operator.said.join("\n")).toContain(secret);
  });

  it("records that it happened", async () => {
    const secret = generateTotpSecret();
    await runSetup(pool, anOperator(goodAnswers(secret), secret));

    const entries = await new AuditRepository(pool).read({ action: "staff.account_created" });
    expect(entries[0]).toMatchObject({ actorKind: "system", outcome: "succeeded" });
    expect(entries[0]?.detail["by"]).toBe("the setup step");
  });

  it("never says the password back", async () => {
    const secret = generateTotpSecret();
    const operator = anOperator(goodAnswers(secret), secret);

    await runSetup(pool, operator);

    expect(operator.said.join("\n")).not.toContain(PASSWORD);
  });
});

describe("it runs once", () => {
  it("declines when an account already exists", async () => {
    await staff.createAccount({
      email: "ada@bank.example",
      displayName: "Ada",
      password: PASSWORD,
      role: "support_officer",
    });
    const secret = generateTotpSecret();
    const operator = anOperator(goodAnswers(secret), secret);

    const result = await runSetup(pool, operator);

    expect(result).toEqual({ outcome: "declined", existing: 1 });
    // It must not have asked for anything, let alone created a second account.
    expect(operator.said.some((line) => line.startsWith("Email:"))).toBe(false);
    expect(await staff.countAccounts()).toBe(1);
  });

  it("says where the next account comes from instead", async () => {
    await staff.createAccount({
      email: "ada@bank.example",
      displayName: "Ada",
      password: PASSWORD,
      role: "administrator",
    });
    const operator = anOperator([], generateTotpSecret());

    await runSetup(pool, operator);

    expect(operator.said.join("\n")).toContain("from the Dashboard");
  });
});

describe("what it refuses", () => {
  it("refuses a password too short to be worth hashing, creating nothing", async () => {
    const secret = generateTotpSecret();
    const operator = anOperator(["grace@bank.example", "Grace", "short", "000000"], secret);

    const result = await runSetup(pool, operator);

    expect(result.outcome).toBe("refused");
    expect(await staff.countAccounts()).toBe(0);
  });

  it("refuses something that is not an email", async () => {
    const secret = generateTotpSecret();
    const operator = anOperator(["grace", "Grace", PASSWORD, "000000"], secret);

    expect((await runSetup(pool, operator)).outcome).toBe("refused");
    expect(await staff.countAccounts()).toBe(0);
  });

  it("refuses an empty display name, because a Customer is told it", async () => {
    const secret = generateTotpSecret();
    const operator = anOperator(["grace@bank.example", "  ", PASSWORD, "000000"], secret);

    expect((await runSetup(pool, operator)).outcome).toBe("refused");
  });
});

describe("when the code does not verify", () => {
  it("leaves an account that cannot sign in, and says so plainly", async () => {
    const secret = generateTotpSecret();
    const operator = anOperator(
      ["grace@bank.example", "Grace", PASSWORD, "000000"],
      secret,
    );

    const result = await runSetup(pool, operator);

    expect(result.outcome).toBe("created_without_mfa");
    expect((await staff.findByEmail("grace@bank.example"))?.mfaEnrolled).toBe(false);
    expect(operator.said.join("\n")).toContain("cannot sign in");
  });

  it("means an Administrator who genuinely cannot get in, rather than one who half can", async () => {
    const secret = generateTotpSecret();
    await runSetup(pool, anOperator(["grace@bank.example", "Grace", PASSWORD, "000000"], secret));

    const auth = new AuthenticationService(staff, new AuditRepository(pool));
    const attempt = await auth.authenticate({
      method: "password",
      email: "grace@bank.example",
      password: PASSWORD,
    });

    expect(attempt).toEqual({ outcome: "mfa_required", enrolled: false });
  });
});
