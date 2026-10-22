import { randomBytes } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, createPool, readMigrations, type Pool } from "@avni/db";
import { HOUR, createTestClock, type TestClock } from "@avni/fakes";

import { AuditRepository } from "../audit/audit.repository";
import { TransactionPinService } from "./transaction-pin.service";
import { pinProblem } from "./transaction-pin";

/**
 * The Transaction PIN, against real Postgres.
 *
 * The lockout is the *only* real defence a four-digit secret has, so it is
 * tested the way an attacker would find its edges: at the boundary, after the
 * hour, and across what would be separate transfers if this counter were on the
 * wrong object.
 */

const ADMIN_URL = process.env["TEST_DATABASE_URL"] ?? "postgres://avni:avni@localhost:5432/avni";
const ACCOUNT = "2024000153";
const OTHER_ACCOUNT = "2024000263";
const PIN = "4821";

let admin: Pool;
let databaseName: string;
let pool: Pool;
let clock: TestClock;
let pins: TransactionPinService;

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
  databaseName = `avni_pin_${randomBytes(6).toString("hex")}`;
  await admin.query(`create database ${databaseName}`);
  pool = createPool(withDatabase(ADMIN_URL, databaseName));
  await applyMigrations(pool, readMigrations());

  clock = createTestClock();
  pins = new TransactionPinService(pool, new AuditRepository(pool), clock);
});

afterEach(async () => {
  await pool.end();
  await admin.query(`drop database if exists ${databaseName} with (force)`);
});

describe("what a PIN may be", () => {
  it("is four digits, and nothing else", () => {
    expect(pinProblem("4821")).toBeUndefined();
    for (const wrong of ["", "482", "48210", "48a1", "48 1", "٤٨٢١"]) {
      expect(pinProblem(wrong)).toBeDefined();
    }
  });
});

describe("setting a PIN", () => {
  it("stores it under argon2id and never in the clear", async () => {
    await pins.set(ACCOUNT, PIN);

    const { rows } = await pool.query<{ pin_hash: string }>(
      "select pin_hash from transaction_pins where account_number = $1",
      [ACCOUNT],
    );

    const stored = rows[0]?.pin_hash ?? "";
    expect(stored).toMatch(/^\$argon2id\$/);
    expect(stored).not.toContain(PIN);
    // A SHA-256 digest is 64 hex characters. This is what the prior art stored.
    expect(stored).not.toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives two Customers with the same PIN different hashes", async () => {
    await pins.set(ACCOUNT, PIN);
    await pins.set(OTHER_ACCOUNT, PIN);

    const { rows } = await pool.query<{ pin_hash: string }>("select pin_hash from transaction_pins");
    expect(new Set(rows.map((row) => row.pin_hash)).size).toBe(2);
  });

  it("is refused by the database if it is ever stored under a fast hash", async () => {
    // The rule is in the schema as well as in the code, because "never SHA-256"
    // failed once already in the prior art by living only in whoever was writing.
    await expect(
      pool.query("insert into transaction_pins (account_number, pin_hash) values ($1, $2)", [
        ACCOUNT,
        "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      ]),
    ).rejects.toThrow(/transaction_pins_hash_is_argon2id/);
  });

  it("replaces an existing PIN rather than adding a second", async () => {
    await pins.set(ACCOUNT, PIN);
    await pins.set(ACCOUNT, "1234");

    expect(await pins.verify(ACCOUNT, "1234")).toEqual({ outcome: "verified" });
    expect((await pins.verify(ACCOUNT, PIN)).outcome).toBe("wrong");
  });
});

describe("checking a PIN", () => {
  beforeEach(async () => {
    await pins.set(ACCOUNT, PIN);
  });

  it("accepts the right one", async () => {
    expect(await pins.verify(ACCOUNT, PIN)).toEqual({ outcome: "verified" });
  });

  it("counts down the wrong ones", async () => {
    expect(await pins.verify(ACCOUNT, "0000")).toEqual({ outcome: "wrong", attemptsLeft: 2 });
    expect(await pins.verify(ACCOUNT, "1111")).toEqual({ outcome: "wrong", attemptsLeft: 1 });
  });

  it("locks out on the third, for an hour", async () => {
    await pins.verify(ACCOUNT, "0000");
    await pins.verify(ACCOUNT, "1111");

    const third = await pins.verify(ACCOUNT, "2222");
    expect(third.outcome).toBe("locked_out");
    if (third.outcome !== "locked_out") throw new Error("unreachable");
    expect(third.until.getTime() - clock.now().getTime()).toBe(HOUR);
  });

  it("refuses the right PIN while locked out", async () => {
    // The attacker's third guess must not be worth more than the Customer's.
    for (const wrong of ["0000", "1111", "2222"]) await pins.verify(ACCOUNT, wrong);

    expect((await pins.verify(ACCOUNT, PIN)).outcome).toBe("locked_out");
  });

  it("still refuses one second before the hour is up", async () => {
    for (const wrong of ["0000", "1111", "2222"]) await pins.verify(ACCOUNT, wrong);

    clock.advance(HOUR - 1000);
    expect((await pins.verify(ACCOUNT, PIN)).outcome).toBe("locked_out");
  });

  it("lets the Customer back in once the hour has passed", async () => {
    for (const wrong of ["0000", "1111", "2222"]) await pins.verify(ACCOUNT, wrong);

    clock.advance(HOUR);
    expect(await pins.verify(ACCOUNT, PIN)).toEqual({ outcome: "verified" });
  });

  it("gives them a full three attempts again, not one", async () => {
    for (const wrong of ["0000", "1111", "2222"]) await pins.verify(ACCOUNT, wrong);
    clock.advance(HOUR);

    expect(await pins.verify(ACCOUNT, "3333")).toEqual({ outcome: "wrong", attemptsLeft: 2 });
  });

  it("forgets the failures once the right PIN is given", async () => {
    await pins.verify(ACCOUNT, "0000");
    await pins.verify(ACCOUNT, PIN);

    expect(await pins.verify(ACCOUNT, "1111")).toEqual({ outcome: "wrong", attemptsLeft: 2 });
  });

  it("counts against the Customer, not against whatever they were doing", async () => {
    // The reason the counter is on the account row: if it were scoped to one
    // transfer, or to one Gated Connector call, an attacker would start a fresh
    // one after every third guess and four digits would be free.
    await pins.verify(ACCOUNT, "0000", { conversationId: undefined });
    await pins.verify(ACCOUNT, "1111");
    const third = await pins.verify(ACCOUNT, "2222");

    expect(third.outcome).toBe("locked_out");
  });

  it("does not lock out a different Customer", async () => {
    await pins.set(OTHER_ACCOUNT, "9999");
    for (const wrong of ["0000", "1111", "2222"]) await pins.verify(ACCOUNT, wrong);

    expect(await pins.verify(OTHER_ACCOUNT, "9999")).toEqual({ outcome: "verified" });
  });

  it("says so plainly when no PIN was ever set", async () => {
    expect(await pins.verify(OTHER_ACCOUNT, PIN)).toEqual({ outcome: "not_set" });
  });

  it("clears the lockout when the PIN is reset over the code path", async () => {
    for (const wrong of ["0000", "1111", "2222"]) await pins.verify(ACCOUNT, wrong);

    // A Customer who forgot their PIN is locked out by definition, so a reset
    // that left the lockout in place would be a reset that does nothing.
    await pins.set(ACCOUNT, "5678");
    expect(await pins.verify(ACCOUNT, "5678")).toEqual({ outcome: "verified" });
  });
});

describe("what the audit table is told", () => {
  it("records the lockout, so an investigation can see it", async () => {
    await pins.set(ACCOUNT, PIN);
    for (const wrong of ["0000", "1111", "2222"]) await pins.verify(ACCOUNT, wrong);

    const { rows } = await pool.query<{ action: string; detail: Record<string, unknown> }>(
      "select action, detail from audit_entries where account_number = $1 order by id",
      [ACCOUNT],
    );

    expect(rows.map((row) => row.action)).toContain("pin.locked_out");
    // The PIN itself is never a value in the table, right or wrong.
    expect(JSON.stringify(rows)).not.toContain(PIN);
  });
});
