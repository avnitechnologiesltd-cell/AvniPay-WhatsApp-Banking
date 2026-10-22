import { randomBytes } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, createPool, readMigrations, type Pool } from "@avni/db";

import { AuditRepository } from "../audit/audit.repository";
import { AuthenticationService } from "./authentication";
import { hashPassword, needsRehash, passwordProblem, verifyPassword } from "./passwords";
import { StaffRepository } from "./staff.repository";
import { generateTotpSecret, totp } from "./totp";

const ADMIN_URL = process.env["TEST_DATABASE_URL"] ?? "postgres://avni:avni@localhost:5432/avni";
const PASSWORD = "a-long-enough-password";

let admin: Pool;
let databaseName: string;
let pool: Pool;
let staff: StaffRepository;
let audit: AuditRepository;
let auth: AuthenticationService;

const withDatabase = (connectionString: string, name: string): string => {
  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  return url.toString();
};

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await admin.query("select 1");
});

afterAll(async () => {
  await admin.end();
});

beforeEach(async () => {
  databaseName = `avni_staff_${randomBytes(6).toString("hex")}`;
  await admin.query(`create database ${databaseName}`);
  pool = createPool(withDatabase(ADMIN_URL, databaseName));
  await applyMigrations(pool, readMigrations());

  staff = new StaffRepository(pool);
  audit = new AuditRepository(pool);
  auth = new AuthenticationService(staff, audit);
});

afterEach(async () => {
  await pool.end();
  await admin.query(`drop database if exists ${databaseName} with (force)`);
});

const anOfficer = async (email = "ada@bank.example") =>
  staff.createAccount({ email, displayName: "Ada", password: PASSWORD, role: "support_officer" });

const anAdministrator = async (email = "grace@bank.example") => {
  const account = await staff.createAccount({
    email,
    displayName: "Grace",
    password: PASSWORD,
    role: "administrator",
  });
  const secret = generateTotpSecret();
  await staff.enrolMfa(account.id, secret);
  return { account, secret };
};

describe("hashing", () => {
  it("uses argon2id, never SHA-256", async () => {
    const account = await anOfficer();
    const { rows } = await pool.query<{ password_hash: string }>(
      "select password_hash from staff_accounts where id = $1",
      [account.id],
    );

    expect(rows[0]?.password_hash.startsWith("$argon2id$")).toBe(true);
    // A SHA-256 hex digest is 64 characters and nothing else.
    expect(rows[0]?.password_hash).not.toMatch(/^[0-9a-f]{64}$/);
  });

  it("salts per account, so two staff with one password differ", async () => {
    // The prior art used one shared static salt, which tells an attacker
    // reading a dump exactly who to try first.
    const first = await hashPassword(PASSWORD);
    const second = await hashPassword(PASSWORD);

    expect(first).not.toBe(second);
    expect(await verifyPassword(first, PASSWORD)).toBe(true);
    expect(await verifyPassword(second, PASSWORD)).toBe(true);
  });

  it("answers false rather than throwing on a damaged hash", async () => {
    // A 500 here would tell an attacker they found an account worth attention.
    expect(await verifyPassword("not-a-hash", PASSWORD)).toBe(false);
    expect(await verifyPassword("", PASSWORD)).toBe(false);
  });

  it("knows when a hash was made with weaker parameters", () => {
    expect(needsRehash("$argon2id$v=19$m=4096,t=1,p=1$abc$def")).toBe(true);
    expect(needsRehash("$argon2id$v=19$m=19456,t=2,p=1$abc$def")).toBe(false);
    expect(needsRehash("sha256:whatever")).toBe(true);
  });

  it("requires length and nothing else", () => {
    // Composition rules push people toward `Password1!`; length is what buys
    // entropy.
    expect(passwordProblem("short")).toMatch(/at least 12/);
    expect(passwordProblem("all lowercase and long enough")).toBeUndefined();
    expect(passwordProblem("x".repeat(300))).toMatch(/at most/);
  });
});

describe("signing in", () => {
  it("lets a Support Officer in with the right password", async () => {
    await anOfficer();

    const result = await auth.authenticate({
      method: "password",
      email: "ada@bank.example",
      password: PASSWORD,
    });

    expect(result.outcome).toBe("signed_in");
  });

  it("matches the email case-insensitively", async () => {
    await anOfficer("ada@bank.example");

    const result = await auth.authenticate({
      method: "password",
      email: "Ada@Bank.Example",
      password: PASSWORD,
    });

    expect(result.outcome).toBe("signed_in");
  });

  it("refuses the wrong password", async () => {
    await anOfficer();

    expect(
      (await auth.authenticate({ method: "password", email: "ada@bank.example", password: "wrong-password" }))
        .outcome,
    ).toBe("refused");
  });

  it("refuses an unknown email with the same answer as a wrong password", async () => {
    await anOfficer();

    const unknown = await auth.authenticate({
      method: "password",
      email: "nobody@bank.example",
      password: PASSWORD,
    });
    const wrong = await auth.authenticate({
      method: "password",
      email: "ada@bank.example",
      password: "wrong-password",
    });

    expect(unknown).toEqual(wrong);
  });

  it("refuses a disabled account", async () => {
    const account = await anOfficer();
    await staff.setDisabled(account.id, true);

    expect(
      (await auth.authenticate({ method: "password", email: "ada@bank.example", password: PASSWORD }))
        .outcome,
    ).toBe("refused");
  });

  it("records every attempt, successful or not", async () => {
    await anOfficer();
    await auth.authenticate({ method: "password", email: "ada@bank.example", password: PASSWORD });
    await auth.authenticate({ method: "password", email: "ada@bank.example", password: "wrong-password" });
    await auth.authenticate({ method: "password", email: "nobody@bank.example", password: PASSWORD });

    const entries = await audit.read({ action: "staff.sign_in" });

    expect(entries.map((entry) => entry.outcome)).toEqual(["refused", "refused", "succeeded"]);
  });

  it("never records the password", async () => {
    await anOfficer();
    await auth.authenticate({ method: "password", email: "ada@bank.example", password: PASSWORD });

    expect(JSON.stringify(await audit.read())).not.toContain(PASSWORD);
  });
});

describe("MFA", () => {
  it("is required for an Administrator", async () => {
    const { account, secret } = await anAdministrator();

    const withoutCode = await auth.authenticate({
      method: "password",
      email: account.email,
      password: PASSWORD,
    });
    expect(withoutCode).toEqual({ outcome: "mfa_required", enrolled: true });

    const withCode = await auth.authenticate({
      method: "password",
      email: account.email,
      password: PASSWORD,
      totpCode: totp(secret, Date.now()),
    });
    expect(withCode.outcome).toBe("signed_in");
  });

  it("refuses an Administrator who has not enrolled, rather than letting them through", async () => {
    // "Just this once" is how a requirement becomes optional.
    await staff.createAccount({
      email: "new@bank.example",
      displayName: "New",
      password: PASSWORD,
      role: "administrator",
    });

    const result = await auth.authenticate({
      method: "password",
      email: "new@bank.example",
      password: PASSWORD,
    });

    expect(result).toEqual({ outcome: "mfa_required", enrolled: false });
  });

  it("is optional for a Support Officer in v1", async () => {
    await anOfficer();

    expect(
      (await auth.authenticate({ method: "password", email: "ada@bank.example", password: PASSWORD }))
        .outcome,
    ).toBe("signed_in");
  });

  it("applies to a Support Officer who chose to enrol", async () => {
    const account = await anOfficer();
    const secret = generateTotpSecret();
    await staff.enrolMfa(account.id, secret);

    const withoutCode = await auth.authenticate({
      method: "password",
      email: account.email,
      password: PASSWORD,
    });
    expect(withoutCode).toEqual({ outcome: "mfa_required", enrolled: true });
  });

  it("refuses a wrong code, and an expired one", async () => {
    const { account, secret } = await anAdministrator();
    const now = Date.now();

    for (const code of ["000000", totp(secret, now - 5 * 60_000)]) {
      expect(
        (
          await auth.authenticate({
            method: "password",
            email: account.email,
            password: PASSWORD,
            totpCode: code,
          })
        ).outcome,
      ).toBe("refused");
    }
  });

  it("refuses the right code with the wrong password", async () => {
    const { account, secret } = await anAdministrator();

    expect(
      (
        await auth.authenticate({
          method: "password",
          email: account.email,
          password: "wrong-password",
          totpCode: totp(secret, Date.now()),
        })
      ).outcome,
    ).toBe("refused");
  });
});

describe("sessions", () => {
  const signIn = async () => {
    await anOfficer();
    const result = await auth.authenticate({
      method: "password",
      email: "ada@bank.example",
      password: PASSWORD,
    });
    if (result.outcome !== "signed_in") expect.unreachable();
    return result;
  };

  it("resolves the token to the account on every request", async () => {
    const { session } = await signIn();

    const resolved = await auth.accountForToken(session.token);

    expect(resolved?.account.email).toBe("ada@bank.example");
  });

  it("stores only a hash, so a dump is not a set of live logins", async () => {
    const { session } = await signIn();
    const { rows } = await pool.query<{ token_hash: string }>("select token_hash from staff_sessions");

    expect(rows[0]?.token_hash).not.toBe(session.token);
    expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is killed immediately when revoked, with no redeploy", async () => {
    const { session } = await signIn();
    await staff.revokeSession(session.session.id);

    expect(await auth.accountForToken(session.token)).toBeUndefined();
  });

  it("kills every session an account holds at once", async () => {
    await anOfficer();
    const tokens: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const result = await auth.authenticate({
        method: "password",
        email: "ada@bank.example",
        password: PASSWORD,
      });
      if (result.outcome !== "signed_in") expect.unreachable();
      tokens.push(result.session.token);
    }
    const account = await staff.findByEmail("ada@bank.example");

    const killed = await staff.revokeAllSessions(account?.id ?? "");

    expect(killed).toBe(3);
    for (const token of tokens) {
      expect(await auth.accountForToken(token)).toBeUndefined();
    }
  });

  it("stops working when the account is disabled", async () => {
    const { session, account } = await signIn();
    await staff.setDisabled(account.id, true);

    expect(await auth.accountForToken(session.token)).toBeUndefined();
  });

  it("refuses a token nobody issued", async () => {
    await signIn();

    expect(await auth.accountForToken("made-up-token")).toBeUndefined();
    expect(await auth.accountForToken(undefined)).toBeUndefined();
    expect(await auth.accountForToken("")).toBeUndefined();
  });

  it("expires", async () => {
    const { session } = await signIn();
    await pool.query("update staff_sessions set expires_at = now() - interval '1 minute'");

    expect(await auth.accountForToken(session.token)).toBeUndefined();
  });

  it("is ended by signing out", async () => {
    const { session, account } = await signIn();

    await auth.signOut(session.session.id, account.id);

    expect(await auth.accountForToken(session.token)).toBeUndefined();
  });
});

describe("the account store", () => {
  it("is empty on a fresh deployment", async () => {
    // No default `admin`, which is what the prior art created on first boot.
    expect(await staff.countAccounts()).toBe(0);
  });

  it("refuses a second account with the same email in another case", async () => {
    await anOfficer("ada@bank.example");

    await expect(anOfficer("ADA@bank.example")).rejects.toThrow();
  });

  it("disables rather than deletes, so audit rows stay resolvable", async () => {
    const account = await anOfficer();
    await staff.setDisabled(account.id, true);

    expect((await staff.findById(account.id))?.disabled).toBe(true);
  });

  it("never exposes a password hash or an MFA secret on the account shape", async () => {
    const { account } = await anAdministrator();
    const found = await staff.findById(account.id);

    expect(JSON.stringify(found)).not.toContain("$argon2id$");
    expect(found).not.toHaveProperty("passwordHash");
    expect(found).not.toHaveProperty("mfaSecret");
  });
});
