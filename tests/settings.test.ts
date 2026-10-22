import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { saidPayload } from "@avni/fakes";

import { readAuditEntries, type AuditEntry } from "../apps/dashboard/src/audit";
import { MiddlewareRefused } from "../apps/dashboard/src/middleware-client";
import {
  createOfficer,
  listOfficerSessions,
  listOfficers,
  readSettings,
  readTariff,
  resetOfficerPassword,
  revokeOfficerSessions,
  updateOfficer,
  writeSetting,
  writeTariff,
  type Tariff,
} from "../apps/dashboard/src/settings";
import { beginEnrolment, confirmEnrolment, signIn, whoIsSignedIn } from "../apps/dashboard/src/staff";

import {
  BANK_CODE,
  PHONE_NUMBER_ID,
  exchangeFlow,
  flowTokenFrom,
  postWebhook,
  startHarness,
  waitFor,
  type Harness,
} from "./harness";

/**
 * **The Settings surface: the configuration a bank changes on its own schedule,
 * without asking a vendor.**
 *
 * Everything an Administrator does here goes in through the Dashboard's own
 * module against a real Middleware, and every claim is checked where the change
 * actually lands — on a Customer's Confirmation screen, in the sentence a
 * Customer is told out of hours, in the mailbox the Bank named, and in the name
 * a Customer is given when a human takes over.
 *
 * The tariff is the one that matters most and the reason this is a screen at
 * all. The prior art hardcoded *"Fee: NGN 30.00"* — a number lifted from a
 * different product entirely — and **an invented fee on a licensed bank's
 * confirmation screen is a compliance problem rather than a cosmetic one.** So
 * the tests that matter most here are the ones that hold the platform to
 * quoting nothing it was not given.
 */

const CUSTOMER = "2348012345678";
const ACCOUNT = "2024000153";
const PAYER = "JANE BOND DOE";
const DESTINATION = "2124955312";
const RECIPIENT = "CHIDI EZE";
const PIN = "4821";

/**
 * Another bank, and its NIBSS code. **The tariff prices the two routes
 * separately**, so a fee test that never leaves this Bank would only ever
 * exercise the half a Nigerian bank usually makes free.
 */
const OTHER_BANK = "Guaranty Trust Bank";
const OTHER_BANK_CODE = "058";
const THERE = "AMINA BELLO";

const envelope = { phoneNumberId: PHONE_NUMBER_ID, from: CUSTOMER };

let harness: Harness;

/** Bands shaped like the NIP tariff, and intra-bank free. Illustrative. */
const NIP: Tariff = {
  intraBank: [{ upTo: null, fee: 0 }],
  interBank: [
    { upTo: 5_000, fee: 10 },
    { upTo: 50_000, fee: 25 },
    { upTo: null, fee: 50 },
  ],
  vatRate: 7.5,
};

const start = async (): Promise<void> => {
  harness = await startHarness({
    accounts: [{ accountNumber: ACCOUNT, availableBalance: 250_000 }],
    names: [
      { accountNumber: DESTINATION, bankCode: BANK_CODE, name: RECIPIENT },
      { accountNumber: DESTINATION, bankCode: OTHER_BANK_CODE, name: THERE, kyc: "3" },
      // The sender, whose name BankOne validates the `Payer` field against on
      // the inter-bank endpoint.
      { accountNumber: ACCOUNT, bankCode: BANK_CODE, name: PAYER },
    ],
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

// --- Signing in, the way the Dashboard's own module does ---------------------

/** Somebody at the Bank, as the Dashboard holds them: a token and a base URL. */
const as = async (
  role: "administrator" | "support_officer",
): Promise<{
  token: string;
  middlewareBaseUrl: string;
  accountId: string;
  email: string;
  password: string;
}> => {
  const staff = await harness.signInStaff(role);
  return { ...staff, middlewareBaseUrl: harness.middlewareUrl };
};

const auditRows = async (action: string): Promise<readonly AuditEntry[]> => {
  const admin = await as("administrator");
  return readAuditEntries({
    token: admin.token,
    middlewareBaseUrl: harness.middlewareUrl,
    action,
  });
};

/** The status the Middleware refused with, or `undefined` if it did not. */
const refusalFrom = async (act: () => Promise<unknown>): Promise<number | undefined> => {
  try {
    await act();
    return undefined;
  } catch (error) {
    if (error instanceof MiddlewareRefused) return error.status;
    throw error;
  }
};

// --- A Customer's Confirmation screen ----------------------------------------

/**
 * Asks for a transfer and comes back holding the sealed surface's token.
 *
 * Polled rather than counted: the webhook returns before the work is done — Meta
 * retries anything that is not a prompt 200 — and the Confirmation screen
 * arrives a turn later.
 */
const askToSend = async (amount: number, bankName = ""): Promise<string> => {
  harness.groq.setResolver(() => ({
    kind: "transfer_to_account",
    amount,
    accountNumber: DESTINATION,
    bankName,
  }));

  // The token from the *previous* transfer, if this test has already made one.
  // `flowTokenFrom` reads the last sealed surface the Customer was sent, so
  // without this a second transfer in one test reads the first one's token and
  // asserts against a screen that was rendered before the tariff changed.
  const before = tokenOrNothing();

  await postWebhook(harness, saidPayload({ ...envelope, text: `send ${amount} to ${DESTINATION}` }));

  return waitFor(() => {
    const token = tokenOrNothing();
    return token !== undefined && token !== before ? token : undefined;
  }, "the sealed surface for the transfer");
};

const tokenOrNothing = (): string | undefined => {
  try {
    return flowTokenFrom(harness);
  } catch {
    return undefined;
  }
};

/** The fee line as the Customer reads it, above their PIN. */
const feeShownFor = async (amount: number, bankName = ""): Promise<string> => {
  const confirm = await exchangeFlow(harness, {
    version: "3.0",
    action: "INIT",
    screen: "",
    data: {},
    flow_token: await askToSend(amount, bankName),
  });

  expect(confirm.screen).toBe("CONFIRM");
  return String(confirm.data["fee_note"]);
};

// --- The tariff ---------------------------------------------------------------

describe("an Administrator enters the Bank's transfer tariff", () => {
  it("puts the Bank's own figure on the Confirmation screen", async () => {
    const admin = await as("administrator");
    await writeTariff(admin, NIP);

    // ₦20,000 to another bank falls in the middle band: ₦25, plus 7.5% VAT on
    // the fee, which is ₦1.88 — and the Customer is told both halves.
    expect(await feeShownFor(20_000, OTHER_BANK)).toBe("Fee ₦26.88, including ₦1.88 VAT.");
  });

  it("prices each band from the amount, on the Bank's own arithmetic", async () => {
    const admin = await as("administrator");
    await writeTariff(admin, NIP);

    expect(await feeShownFor(1_000, OTHER_BANK)).toBe("Fee ₦10.75, including ₦0.75 VAT.");
    expect(await feeShownFor(500_000, OTHER_BANK)).toBe("Fee ₦53.75, including ₦3.75 VAT.");
  });

  it("says a free transfer is free, because the Bank said so", async () => {
    // Intra-bank free is the common Nigerian arrangement, and it is a **value**
    // rather than a rule in the code: the Bank entered `0`, so the screen says
    // there is no fee instead of falling back to saying nothing.
    const admin = await as("administrator");
    await writeTariff(admin, NIP);

    expect(await feeShownFor(20_000)).toBe("No fee for this transfer.");
  });

  it("shows the amount and quotes no figure at all with no tariff entered", async () => {
    // **The honest fallback**, and it is what a fresh deployment does. The
    // prior art's screen read "Fee: NGN 30.00" here, hardcoded, from a
    // different product.
    const fee = await feeShownFor(20_000, OTHER_BANK);

    expect(fee).toBe("Fees apply per your account tariff.");
    expect(fee).not.toMatch(/\d/);
  });

  it("goes back to saying nothing when the Bank withdraws its tariff", async () => {
    // A Bank whose fees are under review has to be able to stop quoting one.
    const admin = await as("administrator");
    await writeTariff(admin, NIP);
    expect(await feeShownFor(20_000, OTHER_BANK)).toContain("₦");

    await writeTariff(admin, null);

    expect(await feeShownFor(20_000, OTHER_BANK)).toBe("Fees apply per your account tariff.");
    expect(await readTariff(admin)).toBeNull();
  });

  it("reads the tariff a Customer is quoted at the moment they are quoted it", async () => {
    // A proposal lives three hours. An Administrator who changes the tariff in
    // between should be the one whose figure the Customer sees when they enter
    // their PIN, rather than a figure the Bank has already replaced.
    const admin = await as("administrator");
    await writeTariff(admin, NIP);

    const token = await askToSend(20_000, OTHER_BANK);
    await writeTariff(admin, { ...NIP, interBank: [{ upTo: null, fee: 100 }], vatRate: 0 });

    const confirm = await exchangeFlow(harness, {
      version: "3.0",
      action: "INIT",
      screen: "",
      data: {},
      flow_token: token,
    });
    expect(confirm.data["fee_note"]).toBe("Fee ₦100.");
  });

  it("refuses a tariff some amount would fall outside, with a reason", async () => {
    // Every amount must have an answer, or a transfer the Bank believed it had
    // priced quietly shows no figure. The refusal is a sentence an
    // Administrator can act on rather than a status code.
    const admin = await as("administrator");

    const refused = await refusalFrom(() =>
      writeTariff(admin, { ...NIP, interBank: [{ upTo: 5_000, fee: 10 }] }),
    );

    expect(refused).toBe(400);
    expect(await readTariff(admin)).toBeNull();
  });
});

describe("a tariff change is a change record", () => {
  it("records who, when, from what and to what", async () => {
    const admin = await as("administrator");
    await writeTariff(admin, NIP);
    await writeTariff(admin, { ...NIP, vatRate: 0 });

    const [latest, first] = await auditRows("tariff.write");

    // **From what, to what.** The first change replaced nothing; the second
    // replaced the first, and the row says so rather than saying only that
    // something changed.
    expect(first?.detail).toMatchObject({ from: null, to: NIP });
    expect(latest?.detail).toMatchObject({ from: NIP, to: { ...NIP, vatRate: 0 } });

    // **Who**, twice over: the account the row is attributed to, and the name
    // that account had at the time — because a change record read six months
    // later must not depend on the account still existing.
    expect(latest?.actorId).toBe(admin.accountId);
    expect(latest?.actorKind).toBe("administrator");
    expect(latest?.detail["by"]).toBe("Staff 1");

    // **When.**
    expect(new Date(String(latest?.recordedAt)).getTime()).toBeGreaterThan(0);
  });

  it("records a refused change as firmly as one that happened", async () => {
    const officer = await as("support_officer");
    await refusalFrom(() => writeTariff(officer, NIP));

    const [row] = await auditRows("tariff.write");
    expect(row?.outcome).toBe("refused");
    expect(row?.actorId).toBe(officer.accountId);
  });

  it("cannot be crowded off the screen by a run of refusals", async () => {
    // The read is limited, and the limit is applied **before** anything the page
    // could filter. So a Support Officer poking at the endpoint a few times
    // would otherwise push the real change out of the window and leave the
    // screen reporting that the tariff had never been changed.
    const admin = await as("administrator");
    await writeTariff(admin, NIP);

    const officer = await as("support_officer");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await refusalFrom(() => writeTariff(officer, NIP));
    }

    const changes = await readAuditEntries({
      token: admin.token,
      middlewareBaseUrl: harness.middlewareUrl,
      action: "tariff.write",
      outcome: "succeeded",
      limit: 3,
    });

    expect(changes).toHaveLength(1);
    expect(changes[0]?.detail).toMatchObject({ from: null, to: NIP });
  });
});

describe("who may change what a Customer is charged", () => {
  it("lets a Support Officer read the tariff", async () => {
    const admin = await as("administrator");
    await writeTariff(admin, NIP);

    const officer = await as("support_officer");
    expect(await readTariff(officer)).toEqual(NIP);
  });

  it("refuses a Support Officer who writes it, and changes nothing", async () => {
    // The first Dashboard surface a Support Officer must not be able to edit,
    // and the reason the Dashboard has two roles rather than one.
    const officer = await as("support_officer");

    expect(await refusalFrom(() => writeTariff(officer, NIP))).toBe(403);

    const admin = await as("administrator");
    expect(await readTariff(admin)).toBeNull();
  });

  it("reads a Support Officer's read as a read, and records it", async () => {
    const officer = await as("support_officer");
    await readTariff(officer);

    const [row] = await auditRows("tariff.read");
    expect(row?.outcome).toBe("succeeded");
    expect(row?.actorId).toBe(officer.accountId);
  });
});

// --- Business hours ------------------------------------------------------------

describe("business hours, set here and read by the out-of-hours message", () => {
  const weekdays = (opens: string, closes: string) => ({
    timeZone: "Africa/Lagos",
    days: {
      monday: { opens, closes },
      tuesday: { opens, closes },
      wednesday: { opens, closes },
      thursday: { opens, closes },
      friday: { opens, closes },
      saturday: null,
      sunday: null,
    },
  });

  it("tells the Customer the hours the Bank entered, and not a string we wrote", async () => {
    // The prior art hardcoded "Business hours: Mon–Fri, 8am–6pm WAT" into the
    // message, which means whoever wrote it had already seen this problem and
    // printed it at the Customer. This is the same sentence with the Bank
    // owning it — set on the Settings screen, read where a Customer waits.
    const admin = await as("administrator");
    await writeSetting(admin, "business_hours", weekdays("09:30", "16:00"));

    // A Sunday in Lagos. The harness clock starts on a Thursday.
    harness.clock.set(new Date("2026-08-23T10:00:00Z"));
    harness.groq.setResolver(() => ({ kind: "talk_to_human" }));
    await postWebhook(harness, saidPayload({ ...envelope, text: "I want a human" }));

    const said = await waitFor(
      () => harness.whatsapp.transcript().find((words) => /member of our team/.test(words)),
      "the out-of-hours message",
    );
    expect(said).toContain("Monday to Friday, 9.30am to 4pm");
  });

  it("is readable by a Support Officer and writable only by an Administrator", async () => {
    const admin = await as("administrator");
    await writeSetting(admin, "business_hours", weekdays("08:00", "18:00"));

    const officer = await as("support_officer");
    expect((await readSettings(officer)).businessHours).toMatchObject({
      timeZone: "Africa/Lagos",
    });
    expect(
      await refusalFrom(() => writeSetting(officer, "business_hours", weekdays("06:00", "23:00"))),
    ).toBe(403);
  });

  it("says which field is wrong rather than answering with a status", async () => {
    const admin = await as("administrator");

    try {
      await writeSetting(admin, "business_hours", weekdays("18:00", "08:00"));
      expect.unreachable("a day that closes before it opens should be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(MiddlewareRefused);
      expect((error as MiddlewareRefused).problem).toContain("close after it opens");
    }
  });
});

// --- The operations alert address ---------------------------------------------

describe("the operations alert address, set here and paged from here", () => {
  it("receives the stuck-transfer alert at the address the Bank named", async () => {
    // A transfer BankOne never resolves. The Customer's money is unaccounted
    // for, so the Bank is paged **outside the Inbox** — and at the address the
    // Administrator entered on the Settings screen rather than one we invented.
    await harness.stop();
    harness = await startHarness({
      accounts: [{ accountNumber: ACCOUNT, availableBalance: 250_000 }],
      names: [{ accountNumber: DESTINATION, bankCode: BANK_CODE, name: RECIPIENT }],
      transfer: { dispatch: "pending", settles: "never" },
    });
    await harness.seedBinding(CUSTOMER, ACCOUNT);
    await harness.seedPin(ACCOUNT, PIN);

    await writeSetting(await as("administrator"), "operations_alert_address", "operations@bank.example");

    const token = await askToSend(2_000);
    // Returns once the inline poll has given up, which is when the Handoff is
    // raised and the desk is paged.
    await exchangeFlow(harness, {
      version: "3.0",
      action: "data_exchange",
      screen: "CONFIRM",
      data: { pin: PIN },
      flow_token: token,
    });

    const alert = await waitFor(
      () => harness.bankIdentity.operationsAlerts[0],
      "the operations desk to be paged",
    );
    expect(alert.address).toBe("operations@bank.example");
    expect(alert.body).toContain(ACCOUNT);
  });

  it("refuses an address that is not an address", async () => {
    const admin = await as("administrator");

    expect(await refusalFrom(() => writeSetting(admin, "operations_alert_address", "the ops team"))).toBe(
      400,
    );
  });
});

// --- Officer accounts ----------------------------------------------------------

describe("an Administrator creates Officer accounts and sets display names", () => {
  const invite = {
    email: "amina@bank.example",
    displayName: "Amina",
    password: "a-long-enough-password",
    role: "support_officer" as const,
  };

  it("creates one who can sign in, and lists them", async () => {
    const admin = await as("administrator");
    const created = await createOfficer(admin, invite);

    expect(created).toMatchObject({ email: invite.email, displayName: "Amina", disabled: false });

    const signedIn = await signIn({
      email: invite.email,
      password: invite.password,
      middlewareBaseUrl: harness.middlewareUrl,
    });
    expect(signedIn.outcome).toBe("signed_in");

    expect((await listOfficers(admin)).map((officer) => officer.email)).toContain(invite.email);
  });

  it("tells the Customer the display name the Administrator set", async () => {
    // **The display name is not cosmetic.** A Customer handed to a human is
    // told who they are speaking to, in both directions, and this is the whole
    // reason Officer accounts are a Dashboard screen rather than a migration.
    const admin = await as("administrator");
    const officer = await createOfficer(admin, { ...invite, displayName: "Amina" });
    await updateOfficer(admin, officer.id, { displayName: "Aisha" });

    const signedIn = await signIn({
      email: invite.email,
      password: invite.password,
      middlewareBaseUrl: harness.middlewareUrl,
    });
    if (signedIn.outcome !== "signed_in") throw new Error("the new Officer could not sign in");

    harness.groq.setResolver(() => ({ kind: "talk_to_human" }));
    await postWebhook(harness, saidPayload({ ...envelope, text: "I want a human" }));

    const handoffId = await waitFor(async () => {
      const response = await fetch(`${harness.middlewareUrl}/dashboard/inbox`, {
        headers: { authorization: `Bearer ${signedIn.token}` },
      });
      const { conversations } = (await response.json()) as { conversations: { handoffId: string }[] };
      return conversations[0]?.handoffId;
    }, "the Handoff to reach the Inbox");

    await fetch(`${harness.middlewareUrl}/dashboard/inbox/${handoffId}/claim`, {
      method: "POST",
      headers: { authorization: `Bearer ${signedIn.token}` },
    });

    const said = await waitFor(
      () => harness.whatsapp.transcript().find((words) => /Aisha/.test(words)),
      "the Customer to be told the Officer's name",
    );
    expect(said).toContain("Aisha");
    expect(harness.whatsapp.transcript().join(" ")).not.toContain("Amina");
  });

  it("refuses a Support Officer who tries any of it, in both directions", async () => {
    const admin = await as("administrator");
    const created = await createOfficer(admin, invite);

    const officer = await as("support_officer");
    // Who else can get in is not a Support Officer's business — the role table
    // gives them no access to this surface rather than read-only access.
    expect(await refusalFrom(() => listOfficers(officer))).toBe(403);
    expect(await refusalFrom(() => updateOfficer(officer, created.id, { displayName: "x" }))).toBe(
      403,
    );
    expect(
      await refusalFrom(() =>
        createOfficer(officer, { ...invite, email: "self@bank.example", role: "administrator" }),
      ),
    ).toBe(403);

    // And it changed nothing.
    expect((await listOfficers(admin)).find((one) => one.id === created.id)?.displayName).toBe(
      "Amina",
    );
  });

  it("ends every session an account holds when it is disabled", async () => {
    const admin = await as("administrator");
    const created = await createOfficer(admin, invite);

    const signedIn = await signIn({
      email: invite.email,
      password: invite.password,
      middlewareBaseUrl: harness.middlewareUrl,
    });
    if (signedIn.outcome !== "signed_in") throw new Error("the new Officer could not sign in");
    expect(await whoIsSignedIn(signedIn.token, harness.middlewareUrl)).toBeDefined();

    await updateOfficer(admin, created.id, { disabled: true });

    // Immediately, not in eight hours. "Their access is off" must be true of
    // every page behind the sign-in as well as of the sign-in itself.
    expect(await whoIsSignedIn(signedIn.token, harness.middlewareUrl)).toBeUndefined();
  });

  it("resets a password and signs that account out everywhere in the same act", async () => {
    const admin = await as("administrator");
    const created = await createOfficer(admin, invite);

    const signedIn = await signIn({
      email: invite.email,
      password: invite.password,
      middlewareBaseUrl: harness.middlewareUrl,
    });
    if (signedIn.outcome !== "signed_in") throw new Error("the new Officer could not sign in");

    const reset = await resetOfficerPassword(admin, created.id, "another-long-password");
    expect(reset.sessionsEnded).toBe(1);

    // Somebody asking for a reset has usually lost control of something.
    expect(await whoIsSignedIn(signedIn.token, harness.middlewareUrl)).toBeUndefined();
    expect(
      (
        await signIn({
          email: invite.email,
          password: "another-long-password",
          middlewareBaseUrl: harness.middlewareUrl,
        })
      ).outcome,
    ).toBe("signed_in");
  });

  it("signs somebody out everywhere without touching their password", async () => {
    const admin = await as("administrator");
    const created = await createOfficer(admin, invite);
    const signedIn = await signIn({
      email: invite.email,
      password: invite.password,
      middlewareBaseUrl: harness.middlewareUrl,
    });
    if (signedIn.outcome !== "signed_in") throw new Error("the new Officer could not sign in");

    expect((await revokeOfficerSessions(admin, created.id)).sessionsEnded).toBe(1);

    expect(await whoIsSignedIn(signedIn.token, harness.middlewareUrl)).toBeUndefined();
    expect(
      (
        await signIn({
          email: invite.email,
          password: invite.password,
          middlewareBaseUrl: harness.middlewareUrl,
        })
      ).outcome,
    ).toBe("signed_in");
  });

  it("refuses a short password rather than storing it", async () => {
    const admin = await as("administrator");

    expect(await refusalFrom(() => createOfficer(admin, { ...invite, password: "short" }))).toBe(400);
  });
});

describe("the deployment cannot be left with no way in", () => {
  it("refuses to disable the last Administrator who can sign in", async () => {
    // The setup step declines once any account exists, so losing the last
    // Administrator has no route back except somebody with database access.
    const admin = await as("administrator");
    const officers = await listOfficers(admin);
    const onlyOne = officers.find((one) => one.role === "administrator");

    expect(await refusalFrom(() => updateOfficer(admin, String(onlyOne?.id), { disabled: true }))).toBe(
      409,
    );
  });

  it("refuses to demote the last Administrator", async () => {
    const admin = await as("administrator");

    expect(
      await refusalFrom(() =>
        updateOfficer(admin, admin.accountId, { role: "support_officer" }),
      ),
    ).toBe(409);
  });

  it("does not count an Administrator who has never enrolled and so cannot sign in", async () => {
    // **The count is of Administrators who could actually sign in.** One
    // created from this screen has no second factor yet, and MFA is required
    // for the role — counting them would let the last usable Administrator be
    // demoted on the strength of an account nobody can get into.
    const admin = await as("administrator");
    await createOfficer(admin, {
      email: "second@bank.example",
      displayName: "Second",
      password: "a-long-enough-password",
      role: "administrator",
    });

    expect(
      await refusalFrom(() => updateOfficer(admin, admin.accountId, { role: "support_officer" })),
    ).toBe(409);
  });

  it("allows it once a second Administrator has enrolled", async () => {
    const admin = await as("administrator");
    // Signs in as a second Administrator, MFA enrolled, the way the harness
    // makes one.
    await as("administrator");

    const demoted = await updateOfficer(admin, admin.accountId, { role: "support_officer" });
    expect(demoted.role).toBe("support_officer");
  });

  it("refuses an Administrator who disables their own account", async () => {
    const admin = await as("administrator");
    await as("administrator");

    // Their own sessions would go with it, so the answer to "did that work"
    // would be the sign-in page.
    expect(await refusalFrom(() => updateOfficer(admin, admin.accountId, { disabled: true }))).toBe(
      409,
    );
  });
});

describe("an Administrator invited from the Dashboard can actually get in", () => {
  const invited = {
    email: "second@bank.example",
    displayName: "Second",
    password: "a-long-enough-password",
    role: "administrator" as const,
  };

  it("cannot sign in until they enrol a second factor, and then can", async () => {
    // **The gap this closes.** MFA is required for an Administrator and the
    // setup step declines once any account exists, so without an enrolment path
    // the Officers screen creates Administrators who can never sign in.
    const admin = await as("administrator");
    await createOfficer(admin, invited);

    const before = await signIn({
      email: invited.email,
      password: invited.password,
      middlewareBaseUrl: harness.middlewareUrl,
    });
    expect(before).toEqual({ outcome: "mfa_required", enrolled: false });

    const offered = await beginEnrolment({
      email: invited.email,
      password: invited.password,
      middlewareBaseUrl: harness.middlewareUrl,
    });
    if (offered.outcome !== "offered") throw new Error("the enrolment was refused");
    expect(offered.uri).toContain("otpauth://totp/");

    const { totp } = await import("@avni/middleware");
    expect(
      await confirmEnrolment({
        email: invited.email,
        password: invited.password,
        totpCode: totp(offered.secret, Date.now()),
        middlewareBaseUrl: harness.middlewareUrl,
      }),
    ).toEqual({ outcome: "enrolled" });

    const after = await signIn({
      email: invited.email,
      password: invited.password,
      totpCode: totp(offered.secret, Date.now()),
      middlewareBaseUrl: harness.middlewareUrl,
    });
    expect(after.outcome).toBe("signed_in");
  });

  it("is not a way in without the password", async () => {
    const admin = await as("administrator");
    await createOfficer(admin, invited);

    expect(
      await beginEnrolment({
        email: invited.email,
        password: "not the password",
        middlewareBaseUrl: harness.middlewareUrl,
      }),
    ).toEqual({ outcome: "refused" });
  });

  it("cannot replace a second factor that already exists", async () => {
    // The one case where a password alone would be **replacing** a factor
    // rather than adding one. An Administrator whose password has leaked must
    // not have their authenticator swapped out from under them.
    const admin = await as("administrator");

    expect(
      await beginEnrolment({
        email: admin.email,
        password: admin.password,
        middlewareBaseUrl: harness.middlewareUrl,
      }),
    ).toEqual({ outcome: "refused" });
  });

  it("leaves nothing behind when the code is never confirmed", async () => {
    const admin = await as("administrator");
    await createOfficer(admin, invited);

    await beginEnrolment({
      email: invited.email,
      password: invited.password,
      middlewareBaseUrl: harness.middlewareUrl,
    });

    // A secret staged and not confirmed is not an enrolment: the account still
    // cannot sign in, which is what keeps a half-finished enrolment from being
    // a way past the requirement.
    expect(
      await signIn({
        email: invited.email,
        password: invited.password,
        middlewareBaseUrl: harness.middlewareUrl,
      }),
    ).toEqual({ outcome: "mfa_required", enrolled: false });
  });
});

// --- Every change writes a row -------------------------------------------------

describe("every change on this surface writes an audit row", () => {
  it("records a settings change with what it was and what it now is", async () => {
    const admin = await as("administrator");
    await writeSetting(admin, "operations_alert_address", "first@bank.example");
    await writeSetting(admin, "operations_alert_address", "second@bank.example");

    const [latest] = await auditRows("settings.write");
    expect(latest?.detail).toMatchObject({
      key: "operations_alert_address",
      from: "first@bank.example",
      to: "second@bank.example",
    });
  });

  it("records reading the settings, and who read them", async () => {
    const officer = await as("support_officer");
    await readSettings(officer);

    const [row] = await auditRows("settings.read");
    expect(row?.actorId).toBe(officer.accountId);
    expect(row?.outcome).toBe("succeeded");
  });

  it("records a new Officer account, the email and the role asked for", async () => {
    const admin = await as("administrator");
    await createOfficer(admin, {
      email: "amina@bank.example",
      displayName: "Amina",
      password: "a-long-enough-password",
      role: "support_officer",
    });

    const [row] = await auditRows("officers.write");
    expect(row?.detail).toMatchObject({
      requestedEmail: "amina@bank.example",
      requestedRole: "support_officer",
    });
  });

  it("records a display-name change with what the name was before", async () => {
    // **The same change-record shape as the tariff**, decided once rather than
    // per screen. The display name is what a Customer was told on a Handoff, so
    // *"what was it before"* is a question about a conversation somebody had.
    const admin = await as("administrator");
    const created = await createOfficer(admin, {
      email: "amina@bank.example",
      displayName: "Amina",
      password: "a-long-enough-password",
      role: "support_officer",
    });
    await updateOfficer(admin, created.id, { displayName: "Aisha" });

    const [row] = await auditRows("officers.write");
    expect(row?.detail).toMatchObject({
      officerId: created.id,
      from: { displayName: "Amina", role: "support_officer", disabled: false },
      to: { displayName: "Aisha", role: "support_officer", disabled: false },
    });
  });

  it("does not record a change that was refused as one that happened", async () => {
    // The row is written **after** the act, because the refusals here come after
    // the capability check: the last-Administrator rule, an account that is not
    // there, a password too short to store. A row written before would say
    // *succeeded* about an act that then threw.
    const admin = await as("administrator");

    await refusalFrom(() => updateOfficer(admin, admin.accountId, { role: "support_officer" }));

    const [row] = await auditRows("officers.write");
    expect(row?.outcome).toBe("refused");
    expect(String(row?.detail["rejected"])).toContain("last Administrator");
  });

  it("records a reset against an account that is not there as a refusal", async () => {
    const admin = await as("administrator");

    await refusalFrom(() =>
      resetOfficerPassword(admin, "00000000-0000-4000-8000-000000000000", "a-long-enough-password"),
    );

    const [row] = await auditRows("officers.password_reset");
    expect(row?.outcome).toBe("refused");
    expect(row?.detail["rejected"]).toBe("no such account");
  });

  it("records a password reset apart from every other change", async () => {
    const admin = await as("administrator");
    const created = await createOfficer(admin, {
      email: "amina@bank.example",
      displayName: "Amina",
      password: "a-long-enough-password",
      role: "support_officer",
    });
    await resetOfficerPassword(admin, created.id, "another-long-password");

    const [row] = await auditRows("officers.password_reset");
    expect(row?.detail).toMatchObject({ officerId: created.id });
    // The password itself is never in a row, and the writer redacts it anyway.
    expect(JSON.stringify(row?.detail)).not.toContain("another-long-password");
  });

  it("records signing somebody out everywhere", async () => {
    const admin = await as("administrator");
    const created = await createOfficer(admin, {
      email: "amina@bank.example",
      displayName: "Amina",
      password: "a-long-enough-password",
      role: "support_officer",
    });
    await revokeOfficerSessions(admin, created.id);

    const [row] = await auditRows("staff.sessions_revoked");
    expect(row?.detail).toMatchObject({ officerId: created.id });
  });

  it("records handing out a secret, apart from the enrolment it may become", async () => {
    // **Written on the way out, not only on refusal.** A secret has just been
    // handed to a caller who proved a password and nothing else, on an
    // unauthenticated route — a row saying so is the whole of the Bank's
    // visibility into that, and it is the row an investigation into a swapped
    // authenticator would start from.
    const admin = await as("administrator");
    await createOfficer(admin, {
      email: "second@bank.example",
      displayName: "Second",
      password: "a-long-enough-password",
      role: "administrator",
    });

    await beginEnrolment({
      email: "second@bank.example",
      password: "wrong",
      middlewareBaseUrl: harness.middlewareUrl,
    });
    const offered = await beginEnrolment({
      email: "second@bank.example",
      password: "a-long-enough-password",
      middlewareBaseUrl: harness.middlewareUrl,
    });

    const rows = await auditRows("staff.mfa_offered");
    expect(rows.map((row) => row.outcome)).toEqual(["succeeded", "refused"]);
    // The secret itself is never in a row.
    if (offered.outcome === "offered") {
      expect(JSON.stringify(rows)).not.toContain(offered.secret);
    }

    // Nothing is recorded as an *enrolment* until somebody proves the code.
    expect(await auditRows("staff.mfa_enrolled")).toHaveLength(0);
  });
});

// --- The sessions somebody is holding -------------------------------------------

describe("what an account is signed in on", () => {
  const invite = {
    email: "amina@bank.example",
    displayName: "Amina",
    password: "a-long-enough-password",
    role: "support_officer" as const,
  };

  it("shows a session without showing anything that could become one", async () => {
    // Ticket 28 put `user_agent` and `ip_address` on the sessions table for this
    // screen and nothing read them. Without it, "sign out everywhere" is a
    // button pressed without knowing there was anything to sign out.
    const admin = await as("administrator");
    const created = await createOfficer(admin, invite);

    const signedIn = await signIn({
      email: invite.email,
      password: invite.password,
      middlewareBaseUrl: harness.middlewareUrl,
    });
    if (signedIn.outcome !== "signed_in") throw new Error("the new Officer could not sign in");

    const sessions = await listOfficerSessions(admin, created.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBeTruthy();

    // **No token and no hash of one.** A session is named by an id that cannot
    // be used to become it.
    expect(JSON.stringify(sessions)).not.toContain(signedIn.token);
  });

  it("stops listing a session the moment it is revoked", async () => {
    const admin = await as("administrator");
    const created = await createOfficer(admin, invite);
    await signIn({
      email: invite.email,
      password: invite.password,
      middlewareBaseUrl: harness.middlewareUrl,
    });

    await revokeOfficerSessions(admin, created.id);

    expect(await listOfficerSessions(admin, created.id)).toEqual([]);
  });

  it("is not a Support Officer's business", async () => {
    const admin = await as("administrator");
    const created = await createOfficer(admin, invite);

    const officer = await as("support_officer");
    expect(await refusalFrom(() => listOfficerSessions(officer, created.id))).toBe(403);
  });
});
