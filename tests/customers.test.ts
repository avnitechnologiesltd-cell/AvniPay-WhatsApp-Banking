import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { saidPayload, type FakeTransaction } from "@avni/fakes";

import {
  MiddlewareRefused,
  readCustomer as readCustomerFromDashboard,
  readCustomerBeneficiaries as readBeneficiariesFromDashboard,
  readCustomerTransactions as readTransactionsFromDashboard,
  revokeBinding as revokeFromDashboard,
  searchCustomers as searchFromDashboard,
} from "../apps/dashboard/src/customers";
import { formatMovement, formatNaira } from "../apps/dashboard/src/format";
import { signIn, whoIsSignedIn } from "../apps/dashboard/src/staff";

import {
  BANK_CODE,
  PHONE_NUMBER_ID,
  exchangeFlow,
  flowTokenFrom,
  postWebhook,
  startHarness,
  waitForReplies,
  type Harness,
} from "./harness";

/**
 * The **Customers surface** — where banking administration and support meet,
 * and the highest-privacy read in the product.
 *
 * A Support Officer looks a Customer up and sees enough to answer *"where did
 * my money go"* without alt-tabbing into BankOne. Almost nothing here changes
 * anything, which is the unusual part: **reading is the sensitive act**, so
 * every one of these journeys ends by checking that the look itself left a row
 * saying who did it and at which Customer.
 *
 * Everything the Officer does goes in over HTTP with a real session, and
 * everything the Customer does goes in through the Platform's webhook or the
 * Middleware's Flows endpoint. Nothing on either side is seeded past the point
 * the product itself can reach — in particular the Beneficiary below is created
 * by walking a real PIN-authorised transfer, because that is the only way one
 * comes into existence.
 */

const CUSTOMER = "2348012345678";
const ACCOUNT = "2024000153";
const CUSTOMER_NAME = "ADAEZE OKAFOR";

/** Somebody the Customer pays, so the Beneficiary view has something to show. */
const MUSA = { account: "2124955312", name: "MUSA IBRAHIM", bank: BANK_CODE };

const PIN = "4821";

const envelope = { phoneNumberId: PHONE_NUMBER_ID, from: CUSTOMER };

/** The harness clock starts here, so these sit inside "last month". */
const SALARY: FakeTransaction = {
  amount: 1_000_000,
  direction: "credit",
  occurredAt: new Date("2026-08-19T08:00:00Z"),
  narration: "Salary August",
  reference: "sal-1",
};
const AIRTIME: FakeTransaction = {
  amount: 5_000,
  direction: "debit",
  occurredAt: new Date("2026-08-20T07:30:00Z"),
  narration: "Airtime MTN",
  reference: "air-1",
};

let harness: Harness;

const start = async (options: { entitled?: boolean } = {}): Promise<void> => {
  harness = await startHarness({
    accounts: [
      {
        accountNumber: ACCOUNT,
        // A million naira, because BankOne sends it as `"1,000,000.00"` and
        // `parseFloat` on that is `1`. The bug only appears above ₦1,000.
        availableBalance: 1_000_000,
        ledgerBalance: 1_050_000,
        withdrawableBalance: 999_000,
        transactions: [SALARY, AIRTIME],
      },
    ],
    names: [
      { accountNumber: ACCOUNT, bankCode: BANK_CODE, name: CUSTOMER_NAME },
      { accountNumber: MUSA.account, bankCode: MUSA.bank, name: MUSA.name },
    ],
    // The first deployment's real answer today. Individual tests turn it on.
    ...(options.entitled === true ? {} : { unentitled: ["GetTransactions"] }),
  });
  await harness.seedBinding(CUSTOMER, ACCOUNT);
  await harness.seedPin(ACCOUNT, PIN);
};

beforeEach(async () => {
  await start();
});

afterEach(async () => {
  await harness?.stop();
});

// --- Driving the Dashboard ----------------------------------------------------

type Role = "support_officer" | "administrator";

interface Answer<T> {
  readonly status: number;
  readonly body: T;
}

const asOfficer = async <T>(
  path: string,
  options: { role?: Role; method?: "GET" | "POST"; token?: string } = {},
): Promise<Answer<T>> => {
  const token = options.token ?? (await harness.signInStaff(options.role ?? "support_officer")).token;
  const response = await fetch(`${harness.middlewareUrl}/dashboard${path}`, {
    method: options.method ?? "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as T };
};

interface SearchBody {
  outcome: string;
  bankSilent?: boolean;
  matches?: {
    accountNumber: string;
    name?: string;
    matchedOn: string;
    bindings: { id: string; maskedIdentity: string; live: boolean }[];
  }[];
}

interface CustomerBody {
  accountNumber: string;
  name?: string;
  accounts: {
    accountNumber: string;
    accountType?: string;
    balances: { outcome: string; available?: unknown; ledger?: unknown; withdrawable?: unknown };
  }[];
  bindings: { id: string; maskedIdentity: string; live: boolean; revokedAt: string | null }[];
}

interface TransactionsBody {
  outcome: string;
  period?: string;
  rows?: { amount: unknown; direction: string; narration?: string; occurredAt?: string }[];
}

interface BeneficiariesBody {
  beneficiaries: {
    label: string;
    nameAtSave: string;
    bankName: string;
    accountNumber: string;
  }[];
}

const search = (q: string, role?: Role): Promise<Answer<SearchBody>> =>
  asOfficer<SearchBody>(`/customers?q=${encodeURIComponent(q)}`, { ...(role ? { role } : {}) });

const readCustomer = (accountNumber = ACCOUNT, role?: Role): Promise<Answer<CustomerBody>> =>
  asOfficer<CustomerBody>(`/customers/${accountNumber}`, { ...(role ? { role } : {}) });

const readTransactions = (period?: string, role?: Role): Promise<Answer<TransactionsBody>> =>
  asOfficer<TransactionsBody>(
    `/customers/${ACCOUNT}/transactions${period ? `?period=${period}` : ""}`,
    { ...(role ? { role } : {}) },
  );

const readBeneficiaries = (role?: Role): Promise<Answer<BeneficiariesBody>> =>
  asOfficer<BeneficiariesBody>(`/customers/${ACCOUNT}/beneficiaries`, { ...(role ? { role } : {}) });

// --- Driving the Customer -----------------------------------------------------

const say = async (text: string): Promise<readonly string[]> => {
  const before = harness.whatsapp.sent.length;
  await postWebhook(harness, saidPayload({ ...envelope, text }));
  const replies = await waitForReplies(harness, before + 1);
  return replies.slice(before);
};

const isLinked = async (): Promise<boolean> => {
  const replies = await say("what's my balance");
  return !(replies.at(-1) ?? "").includes("Do you have a bank account");
};

/**
 * A completed, PIN-authorised transfer, which is the **only** way a Beneficiary
 * comes into existence. There is no seeding, because the product cannot.
 */
const paysMusa = async (saveAs: string): Promise<void> => {
  harness.groq.setResolver(() => ({
    kind: "transfer_to_account",
    amount: 2000,
    accountNumber: MUSA.account,
    bankName: "",
  }));
  await say(`send 2000 to ${MUSA.account}`);
  const token = flowTokenFrom(harness);

  await exchangeFlow(harness, {
    version: "3.0",
    action: "INIT",
    screen: "",
    data: {},
    flow_token: token,
  });
  await exchangeFlow(harness, {
    version: "3.0",
    action: "data_exchange",
    screen: "CONFIRM",
    data: { pin: PIN, save_as: saveAs },
    flow_token: token,
  });
};

// --- The audit table ----------------------------------------------------------

interface Row {
  action: string;
  actorKind: string;
  actorId: string | null;
  accountNumber: string | null;
  outcome: string;
  detail: Record<string, unknown>;
}

const auditRows = async (query = ""): Promise<readonly Row[]> => {
  const { token } = await harness.signInStaff("administrator");
  const response = await fetch(
    `${harness.middlewareUrl}/dashboard/audit?limit=500${query}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  return ((await response.json()) as { entries: Row[] }).entries;
};

const rowsFor = async (action: string): Promise<readonly Row[]> =>
  (await auditRows(`&action=${encodeURIComponent(action)}`)).filter((row) => row.action === action);

// --- Finding a Customer -------------------------------------------------------

describe("a Support Officer looks a Customer up", () => {
  it("finds them by account number, with the bank's own name for the account", async () => {
    const { body } = await search(ACCOUNT);

    expect(body.outcome).toBe("searched");
    expect(body.matches).toHaveLength(1);
    expect(body.matches?.[0]).toMatchObject({
      accountNumber: ACCOUNT,
      name: CUSTOMER_NAME,
      matchedOn: "account_number",
    });
  });

  it("finds them by the number the Customer is calling from", async () => {
    // Typed the way a Customer says it out loud, trunk zero and all.
    const { body } = await search("08012345678");

    expect(body.matches?.[0]).toMatchObject({
      accountNumber: ACCOUNT,
      name: CUSTOMER_NAME,
      matchedOn: "channel_identity",
    });
  });

  it("shows the Binding masked, so an account number does not hand over a mobile number", async () => {
    const { body } = await search(ACCOUNT);
    const [binding] = body.matches?.[0]?.bindings ?? [];

    expect(binding?.live).toBe(true);
    expect(binding?.maskedIdentity).toBe("••• ••• 5678");
    expect(JSON.stringify(body)).not.toContain(CUSTOMER);
  });

  it("says plainly that a name is not something it can search", async () => {
    // There is no name search anywhere in this product: BankOne resolves an
    // account number to a name and never the reverse. An honest refusal beats
    // an empty result that reads as "no such Customer".
    const { body } = await search("Adaeze");

    expect(body.outcome).toBe("unreadable");
    expect(body.matches).toBeUndefined();
  });

  it("finds nobody for an account BankOne does not hold, and does not claim the Bank was silent", async () => {
    const { body } = await search("9999999999");

    expect(body.outcome).toBe("searched");
    expect(body.matches).toEqual([]);
    expect(body.bankSilent).toBe(false);
  });

  it("distinguishes 'no such Customer' from 'the Bank did not answer'", async () => {
    // An Officer who reads the second as the first tells a Customer their
    // account does not exist.
    harness.bankOne.setEntitled("NameEnquiry", false);

    const { body } = await search("9999999999");

    expect(body.matches).toEqual([]);
    expect(body.bankSilent).toBe(true);
  });
});

// --- Accounts and balances ----------------------------------------------------

describe("a Support Officer opens a Customer", () => {
  it("sees the account and its balances", async () => {
    const { body } = await readCustomer();

    expect(body.name).toBe(CUSTOMER_NAME);
    expect(body.accounts[0]?.balances).toMatchObject({
      outcome: "read",
      available: 1_000_000,
      ledger: 1_050_000,
      withdrawable: 999_000,
    });
  });

  it("is shown ₦1,000,000 as a number, and never ₦1 and never a BankOne string", async () => {
    // BankOne sends `"1,000,000.00"`. `parseFloat` on that is `1`, and every
    // documented example misses it because it only fails above ₦1,000. The
    // separator-stripping rule is the adapter's, and this is the assertion that
    // no raw BankOne string got past it on the way to a screen.
    const { body } = await readCustomer();
    const balances = body.accounts[0]?.balances;

    expect(typeof balances?.available).toBe("number");
    expect(balances?.available).toBe(1_000_000);
    expect(JSON.stringify(body)).not.toContain("1,000,000.00");
  });

  it("sees the Binding, and sees a revoked one too", async () => {
    const before = await readCustomer();
    const bindingId = before.body.bindings[0]?.id ?? "";

    await asOfficer(`/customers/${ACCOUNT}/bindings/${bindingId}/revoke`, { method: "POST" });

    const after = await readCustomer();
    expect(after.body.bindings).toHaveLength(1);
    expect(after.body.bindings[0]).toMatchObject({ id: bindingId, live: false });
    expect(after.body.bindings[0]?.revokedAt).not.toBeNull();
  });

  it("is told honestly when BankOne will not answer, rather than shown an empty account", async () => {
    harness.bankOne.setEntitled("GetAccountByAccountNumber", false);

    const { body } = await readCustomer();

    expect(body.accounts[0]?.balances.outcome).toBe("not_available");
    expect(body.accounts[0]?.balances.available).toBeUndefined();
  });

  it("refuses something that is not an account number rather than putting it in a query to BankOne", async () => {
    for (const notAnAccount of ["nine", "202400015", "2024000153x", "2024000153%20"]) {
      expect((await readCustomer(notAnAccount)).status).toBe(400);
    }
  });

  it("records the attempt anyway, because that is the request most worth seeing", async () => {
    // The validation runs **after** the audit row. A Dashboard session probing
    // the Middleware with something that is not an account number is precisely
    // what a table of who-looked-at-what exists to show.
    await readCustomer("nine");

    const [row] = await rowsFor("customer.read");
    expect(row).toMatchObject({ accountNumber: "nine", actorKind: "officer" });
  });
});

// --- History ------------------------------------------------------------------

describe("the transaction history on the Customers surface", () => {
  it("says it cannot look, on the token the Bank actually has today", async () => {
    // Not an error, and not an empty list. An Officer shown a blank would tell
    // a Customer nothing had happened on their account.
    const { status, body } = await readTransactions();

    expect(status).toBe(200);
    expect(body.outcome).toBe("not_available");
    expect(body.rows).toBeUndefined();
  });

  it("shows the rows on the day the entitlement arrives", async () => {
    harness.bankOne.setEntitled("GetTransactions", true);

    const { body } = await readTransactions();

    expect(body.outcome).toBe("read");
    expect(body.period).toBe("last_month");
    expect(body.rows).toHaveLength(2);
    expect(body.rows?.[0]).toMatchObject({ amount: 5_000, direction: "debit", narration: "Airtime MTN" });
    expect(body.rows?.[1]).toMatchObject({ amount: 1_000_000, direction: "credit" });
  });

  it("parses row amounts under the same separator-stripping rule as a balance", async () => {
    harness.bankOne.setEntitled("GetTransactions", true);

    const { body } = await readTransactions();

    expect(body.rows?.[1]?.amount).toBe(1_000_000);
    expect(JSON.stringify(body)).not.toContain("1,000,000.00");
  });

  it("shows the period the Officer chose", async () => {
    harness.bankOne.setEntitled("GetTransactions", true);

    const { body } = await readTransactions("today");

    expect(body.period).toBe("today");
    // The fake ignores the date range on purpose, so the Middleware's own
    // filter is the one under test. Both rows are before today.
    expect(body.rows).toEqual([]);
  });

  it("falls back to a month rather than refusing a period it does not know", async () => {
    harness.bankOne.setEntitled("GetTransactions", true);

    const { status, body } = await readTransactions("since_forever");

    expect(status).toBe(200);
    expect(body.period).toBe("last_month");
  });
});

// --- Beneficiaries ------------------------------------------------------------

describe("who a Customer pays", () => {
  it("is visible to a Support Officer, read-only", async () => {
    await paysMusa("Musa");

    const { body } = await readBeneficiaries();

    expect(body.beneficiaries).toHaveLength(1);
    expect(body.beneficiaries[0]).toMatchObject({
      label: "Musa",
      // The bank's own name for the account, which is the thing an Officer can
      // reconcile against BankOne. The label is the Customer's own word and is
      // never proof of who holds the account.
      nameAtSave: MUSA.name,
      accountNumber: MUSA.account,
    });
  });

  it("is empty for a Customer who has never paid anybody", async () => {
    const { status, body } = await readBeneficiaries();

    expect(status).toBe(200);
    expect(body.beneficiaries).toEqual([]);
  });

  it("has no write anywhere on the surface", async () => {
    await paysMusa("Musa");
    const { beneficiaries } = (await readBeneficiaries()).body;
    expect(beneficiaries).toHaveLength(1);

    const { token } = await harness.signInStaff("administrator");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await fetch(
        `${harness.middlewareUrl}/dashboard/customers/${ACCOUNT}/beneficiaries`,
        { method, headers: { authorization: `Bearer ${token}` } },
      );
      expect(response.status).toBe(404);
    }

    expect((await readBeneficiaries()).body.beneficiaries).toHaveLength(1);
  });

  it("is not reachable from the Platform, which is where the model reads", async () => {
    // The Support Agent never reads this store, and the defence is that there
    // is nowhere for it to read from: the Platform serves no route to it.
    await paysMusa("Musa");

    const response = await fetch(
      `${harness.platformUrl}/dashboard/customers/${ACCOUNT}/beneficiaries`,
    );

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(MUSA.account);
  });
});

// --- The one write ------------------------------------------------------------

describe("an Officer revokes a Binding", () => {
  it("stops the Customer reaching the account", async () => {
    expect(await isLinked()).toBe(true);
    const bindingId = (await readCustomer()).body.bindings[0]?.id ?? "";

    const { status } = await asOfficer(`/customers/${ACCOUNT}/bindings/${bindingId}/revoke`, {
      method: "POST",
    });

    expect(status).toBe(201);
    expect(await isLinked()).toBe(false);
  });

  it("leaves the Customer's saved recipients standing", async () => {
    // The store is keyed on the account, not on the Binding. A Customer who
    // changes handsets does not lose everybody they have ever paid.
    await paysMusa("Musa");
    const bindingId = (await readCustomer()).body.bindings[0]?.id ?? "";

    await asOfficer(`/customers/${ACCOUNT}/bindings/${bindingId}/revoke`, { method: "POST" });

    expect((await readBeneficiaries()).body.beneficiaries).toHaveLength(1);
  });

  it("records who ended it, and says it was staff who did", async () => {
    const bindingId = (await readCustomer()).body.bindings[0]?.id ?? "";
    const { token } = await harness.signInStaff("support_officer");

    await asOfficer(`/customers/${ACCOUNT}/bindings/${bindingId}/revoke`, {
      method: "POST",
      token,
    });

    const [revoked] = await rowsFor("binding.revoked");
    expect(revoked).toMatchObject({ actorKind: "officer", accountNumber: ACCOUNT });
    expect(revoked?.actorId).not.toBeNull();
    expect(String(revoked?.detail["reason"])).toContain("Dashboard");
  });

  it("will not destroy a Binding that belongs to another account", async () => {
    const bindingId = (await readCustomer()).body.bindings[0]?.id ?? "";

    // The same Binding id under an account number that is not its own. If the
    // account in the path were decorative, this would revoke it anyway and the
    // audit row would name the wrong Customer.
    const { status } = await asOfficer(`/customers/2024000263/bindings/${bindingId}/revoke`, {
      method: "POST",
    });

    expect(status).toBe(404);
    expect(await isLinked()).toBe(true);
  });

  it("records an attempt that revoked nothing, which is the one worth seeing", async () => {
    // An Officer walking Binding ids against an account and being refused every
    // time is exactly the shape of probing this table exists to show. Both roles
    // hold `binding.revoke`, so the capability check never refuses here — if the
    // service did not write these rows, nothing would.
    await asOfficer("/customers/2024000263/bindings/not-a-binding/revoke", { method: "POST" });

    const [row] = await rowsFor("binding.revoked");
    expect(row).toMatchObject({
      accountNumber: "2024000263",
      actorKind: "officer",
      outcome: "refused",
    });
    expect(row?.actorId).not.toBeNull();
  });

  it("records the second revoke as well as the first", async () => {
    const bindingId = (await readCustomer()).body.bindings[0]?.id ?? "";
    const path = `/customers/${ACCOUNT}/bindings/${bindingId}/revoke`;

    await asOfficer(path, { method: "POST" });
    await asOfficer(path, { method: "POST" });

    const rows = await rowsFor("binding.revoked");
    expect(rows.map((row) => row.outcome)).toEqual(["refused", "succeeded"]);
  });

  it("is idempotent rather than an error the second time", async () => {
    const bindingId = (await readCustomer()).body.bindings[0]?.id ?? "";
    const path = `/customers/${ACCOUNT}/bindings/${bindingId}/revoke`;

    await asOfficer(path, { method: "POST" });
    const { status } = await asOfficer(path, { method: "POST" });

    expect(status).toBe(201);
  });
});

// --- Every view writes a row --------------------------------------------------

describe("every view on this surface writes an audit row", () => {
  it("records the search, and what was looked for", async () => {
    // Recorded **before** the search runs and whatever it answered. "Who went
    // looking for this Customer" is where an investigation starts, and a row
    // written only on success would omit exactly the probing worth finding.
    await search(ACCOUNT);

    const [row] = await rowsFor("customer.searched");
    expect(row).toMatchObject({ actorKind: "officer", outcome: "succeeded" });
    expect(row?.detail["query"]).toBe(ACCOUNT);
    // In the **column**, not only in the JSON. "Who has looked at this account"
    // is a query the Bank will run, and it cannot run it against `detail`.
    expect(row?.accountNumber).toBe(ACCOUNT);
  });

  it("leaves the account column empty when what was searched for was a phone number", async () => {
    // A phone number is not an account number and must not be filed as one.
    await search("08012345678");

    const [row] = await rowsFor("customer.searched");
    expect(row?.accountNumber).toBeNull();
    expect(row?.detail["query"]).toBe("08012345678");
  });

  it("records a view that changes nothing, against the Customer it was about", async () => {
    await readCustomer();

    const [row] = await rowsFor("customer.read");
    expect(row).toMatchObject({ accountNumber: ACCOUNT, actorKind: "officer", outcome: "succeeded" });
    expect(row?.actorId).not.toBeNull();
  });

  it("records reading a Customer's history, including when it could not be read", async () => {
    await readTransactions();

    const [row] = await rowsFor("customer.transactions_read");
    expect(row).toMatchObject({ accountNumber: ACCOUNT, outcome: "succeeded" });
    expect(row?.detail["period"]).toBe("last_month");

    // And the second row, which says what BankOne answered rather than who
    // looked. `unavailable` is not `failed`.
    const [read] = await rowsFor("banking.transactions_read");
    expect(read).toMatchObject({ accountNumber: ACCOUNT, actorKind: "officer", outcome: "unavailable" });
  });

  it("records reading who a Customer pays", async () => {
    await readBeneficiaries();

    const [row] = await rowsFor("customer.beneficiaries_read");
    expect(row).toMatchObject({ accountNumber: ACCOUNT, outcome: "succeeded" });
    expect(row?.detail["capability"]).toBe("beneficiaries.read");
  });

  it("records an Officer's balance read under the same action a Customer's is", async () => {
    // One query answers "who has read this account's balance", whoever did it
    // and whichever surface they used.
    await readCustomer();
    await say("what's my balance");

    const rows = await rowsFor("banking.balance_read");
    expect(rows.map((row) => row.actorKind).sort()).toEqual(["customer", "officer"]);
  });

  it("never puts the balance in the row", async () => {
    await readCustomer();

    for (const row of await auditRows()) {
      expect(JSON.stringify(row.detail)).not.toContain("1000000");
      expect(JSON.stringify(row.detail)).not.toContain("1,000,000");
    }
  });

  it("never puts who a Customer pays in the row", async () => {
    await paysMusa("Musa");
    await readBeneficiaries();

    const [row] = await rowsFor("customer.beneficiaries_read");
    expect(JSON.stringify(row?.detail)).not.toContain(MUSA.account);
    expect(JSON.stringify(row?.detail)).not.toContain("Musa");
  });
});

// --- Who may look -------------------------------------------------------------

describe("who may use this surface", () => {
  const everySurface = [
    `/customers?q=${ACCOUNT}`,
    `/customers/${ACCOUNT}`,
    `/customers/${ACCOUNT}/transactions`,
    `/customers/${ACCOUNT}/beneficiaries`,
  ];

  it.each(everySurface)("is open to a Support Officer: %s", async (path) => {
    const { status } = await asOfficer(path, { role: "support_officer" });
    expect(status).toBe(200);
  });

  it.each(everySurface)("is open to an Administrator too: %s", async (path) => {
    const { status } = await asOfficer(path, { role: "administrator" });
    expect(status).toBe(200);
  });

  it("lets a Support Officer revoke a Binding, which is nobody's escalation", async () => {
    const bindingId = (await readCustomer()).body.bindings[0]?.id ?? "";

    const { status } = await asOfficer(`/customers/${ACCOUNT}/bindings/${bindingId}/revoke`, {
      method: "POST",
      role: "support_officer",
    });

    expect(status).toBe(201);
  });

  it("is closed to somebody who is not signed in", async () => {
    for (const path of everySurface) {
      const response = await fetch(`${harness.middlewareUrl}/dashboard${path}`);
      expect(response.status).toBe(401);
    }
  });

  it("is closed to a session that has been revoked", async () => {
    const { token } = await harness.signInStaff("support_officer");
    expect((await asOfficer(`/customers/${ACCOUNT}`, { token })).status).toBe(200);

    await fetch(`${harness.middlewareUrl}/dashboard/sign-out`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });

    expect((await asOfficer(`/customers/${ACCOUNT}`, { token })).status).toBe(401);
  });

  it("is not on the Platform, which is the surface a Customer's words reach", async () => {
    for (const path of everySurface) {
      const response = await fetch(`${harness.platformUrl}/dashboard${path}`);
      expect(response.status).toBe(404);
    }
  });
});

// --- The Dashboard's own read path --------------------------------------------

/**
 * The module the screens actually call, driven against a real Middleware.
 *
 * The pages themselves are React and are checked by `next build`; what is worth
 * a test is the seam — the Dashboard reads **through the Middleware** and never
 * from Postgres, so this is where a change to either side shows up.
 */
describe("the Dashboard's read path", () => {
  const dashboard = async (): Promise<{ token: string; middlewareBaseUrl: string }> => ({
    token: (await harness.signInStaff("support_officer")).token,
    middlewareBaseUrl: harness.middlewareUrl,
  });

  it("signs a member of staff in and reads back who they are", async () => {
    const { email, password } = await harness.signInStaff("support_officer");

    const result = await signIn({ email, password, middlewareBaseUrl: harness.middlewareUrl });

    expect(result.outcome).toBe("signed_in");
    if (result.outcome !== "signed_in") return;
    expect(await whoIsSignedIn(result.token, harness.middlewareUrl)).toMatchObject({
      email,
      role: "support_officer",
    });
  });

  it("says the same sentence for an unknown email as for a wrong password", async () => {
    const { email } = await harness.signInStaff("support_officer");
    const base = harness.middlewareUrl;

    expect(await signIn({ email, password: "wrong", middlewareBaseUrl: base })).toEqual({
      outcome: "refused",
    });
    expect(
      await signIn({ email: "nobody@bank.example", password: "wrong", middlewareBaseUrl: base }),
    ).toEqual({ outcome: "refused" });
  });

  it("finds a Customer and renders the balance a human reads", async () => {
    const session = await dashboard();

    const found = await searchFromDashboard(session, ACCOUNT);
    expect(found.outcome).toBe("searched");

    const customer = await readCustomerFromDashboard(session, ACCOUNT);
    const account = customer.accounts[0];
    expect(account?.balances.outcome).toBe("read");
    if (account === undefined || account.balances.outcome !== "read") return;

    // The whole rule, end to end: BankOne sent `"1,000,000.00"`, the adapter
    // parsed it, and this is the string on the screen. Never `₦1.00`.
    expect(formatNaira(account.balances.available)).toBe("₦1,000,000.00");
  });

  it("renders a history row as an amount and a direction in words", async () => {
    harness.bankOne.setEntitled("GetTransactions", true);
    const session = await dashboard();

    const history = await readTransactionsFromDashboard(session, ACCOUNT, "last_month");
    expect(history.outcome).toBe("read");
    if (history.outcome !== "read") return;

    expect(history.rows.map((row) => formatMovement(row.amount, row.direction))).toEqual([
      "₦5,000.00 out",
      "₦1,000,000.00 in",
    ]);
  });

  it("carries the not-available state through to the screen unchanged", async () => {
    const session = await dashboard();

    expect(await readTransactionsFromDashboard(session, ACCOUNT, "last_month")).toEqual({
      outcome: "not_available",
    });
  });

  it("reads a Customer's Beneficiaries, and revokes a Binding", async () => {
    await paysMusa("Musa");
    const session = await dashboard();

    const saved = await readBeneficiariesFromDashboard(session, ACCOUNT);
    expect(saved.map((beneficiary) => beneficiary.nameAtSave)).toEqual([MUSA.name]);

    const customer = await readCustomerFromDashboard(session, ACCOUNT);
    await revokeFromDashboard(session, ACCOUNT, customer.bindings[0]?.id ?? "");

    expect(await isLinked()).toBe(false);
  });

  it("hands a page the status it was refused at, rather than a message to match on", async () => {
    // *"Sign in again"* and *"your role does not allow that"* send an Officer to
    // two different places, and a page cannot tell them apart from prose.
    const refusal = await readCustomerFromDashboard(
      { token: "not-a-session", middlewareBaseUrl: harness.middlewareUrl },
      ACCOUNT,
    ).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(MiddlewareRefused);
    expect((refusal as MiddlewareRefused).status).toBe(401);
  });
});
