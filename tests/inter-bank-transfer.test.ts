import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { saidPayload } from "@avni/fakes";

import {
  BANK_CODE,
  PHONE_NUMBER_ID,
  exchangeFlow,
  flowTokenFrom,
  postWebhook,
  startHarness,
  waitForReplies,
  type Harness,
  type HarnessOptions,
} from "./harness";

/**
 * Sending money to an account at **another** Nigerian bank.
 *
 * The same journey as `intra-bank-transfer.test.ts` and deliberately not a copy
 * of it: everything about the Confirmation screen, the Transaction PIN, the
 * single-use Mandate and the tampered payload is proved there and is the same
 * code here. What is proved here is only what differs — that the bank a Customer
 * named becomes a NIBSS code, that the code alone chooses the endpoint, and that
 * the endpoint is spoken to in its own dialect.
 *
 * **The name enquiry is the test that matters.** The first deployment's staging resolved
 * one fabricated account number to the same holder at two different banks
 * (Appendix A.4), which means the most important element on the Confirmation
 * screen — who actually holds the destination account — cannot be exercised
 * against staging at all. So the fake resolves the *same number* to a
 * **different person** at each bank, and every assertion below turns on the
 * difference. A Middleware that ran the enquiry under the wrong bank code, or
 * skipped it, shows the wrong name and fails here rather than in production.
 */

const CUSTOMER = "2348012345678";
const ACCOUNT = "2024000153";
const PAYER = "JANE BOND DOE";
const DESTINATION = "2124955312";
const PIN = "4821";
const AMOUNT = 2000;

/** Another bank, and its NIBSS code. Not this Bank's, which is what matters. */
const OTHER_BANK = "Guaranty Trust Bank";
const OTHER_BANK_CODE = "058";

/** The same ten digits, and two different people hold them. */
const HERE = "CHIDI EZE";
const THERE = "AMINA BELLO";

const envelope = { phoneNumberId: PHONE_NUMBER_ID, from: CUSTOMER };

let harness: Harness;

const start = async (options: HarnessOptions = {}): Promise<void> => {
  harness = await startHarness({
    accounts: [{ accountNumber: ACCOUNT, availableBalance: 250_000 }],
    names: [
      // One account number, two banks, two holders — the whole point.
      { accountNumber: DESTINATION, bankCode: BANK_CODE, name: HERE },
      { accountNumber: DESTINATION, bankCode: OTHER_BANK_CODE, name: THERE, kyc: "3" },
      // The sender, whose name BankOne validates the `Payer` field against.
      { accountNumber: ACCOUNT, bankCode: BANK_CODE, name: PAYER },
    ],
    ...options,
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

// --- Driving it --------------------------------------------------------------

/**
 * Asks for a transfer and comes back holding the sealed surface's token.
 *
 * The Intent is the **same variant** whichever bank is named. There is no
 * inter-bank kind and nothing in the payload says which endpoint to use.
 */
const askToSend = async (bankName = OTHER_BANK): Promise<string> => {
  harness.groq.setResolver(() => ({
    kind: "transfer_to_account",
    amount: AMOUNT,
    accountNumber: DESTINATION,
    bankName,
  }));

  const before = harness.whatsapp.sent.length;
  await postWebhook(
    harness,
    saidPayload({ ...envelope, text: `send ${AMOUNT} to ${DESTINATION} at ${bankName}` }),
  );
  await waitForReplies(harness, before + 1);

  return flowTokenFrom(harness);
};

const open = (token: string) =>
  exchangeFlow(harness, { version: "3.0", action: "INIT", screen: "", data: {}, flow_token: token });

const submit = (token: string, data: Record<string, unknown>) =>
  exchangeFlow(harness, {
    version: "3.0",
    action: "data_exchange",
    screen: "CONFIRM",
    data,
    flow_token: token,
  });

/** The body of the last inter-bank transfer, as it arrived on the wire. */
const interBankRequest = (): Record<string, unknown> =>
  (harness.bankOne.requests
    .filter((request) => request.path.endsWith("/InterBankTransfer"))
    .at(-1)?.body ?? {}) as Record<string, unknown>;

const nameEnquiries = (): readonly Record<string, unknown>[] =>
  harness.bankOne.requests
    .filter((request) => request.path.endsWith("/NameEnquiry"))
    .map((request) => (request.body ?? {}) as Record<string, unknown>);

// --- The journey -------------------------------------------------------------

describe("a Customer sends money to an account at another bank", () => {
  it("confirms, takes the PIN, moves the money and says so in the same conversation", async () => {
    const token = await askToSend();

    const confirm = await open(token);
    expect(confirm.screen).toBe("CONFIRM");

    const done = await submit(token, { pin: PIN });
    expect(done.screen).toBe("DONE");
    expect(done.data["message"]).toContain(`Sent ₦2,000 to ${THERE}`);

    // Told in the conversation, not only on the screen the Flow closed.
    const replies = await waitForReplies(harness, 2);
    expect(replies.at(-1)).toContain(`Sent ₦2,000 to ${THERE}`);

    expect(harness.bankOne.transfers).toMatchObject([
      {
        endpoint: "InterBankTransfer",
        fromAccountNumber: ACCOUNT,
        toAccountNumber: DESTINATION,
        bankCode: OTHER_BANK_CODE,
        receiverName: THERE,
        payer: PAYER,
        // Naira, and never divided by 100 — the same rule as the other endpoint.
        amount: AMOUNT,
      },
    ]);
  });

  it("shows the name the other bank holds, not the one this Bank holds for that number", async () => {
    const confirm = await open(await askToSend());

    // **The anti-fraud element on the screen, and the one staging cannot
    // exercise.** The same ten digits belong to CHIDI EZE at this Bank and to
    // AMINA BELLO at the other, so an enquiry run under the wrong bank code —
    // or a stubbed one that answers the same thing whatever it is asked —
    // shows a name that is not the recipient's and fails here.
    expect(confirm.data["destination_name"]).toBe(THERE);
    expect(confirm.data["destination_name"]).not.toBe(HERE);

    expect(confirm.data).toMatchObject({
      amount: "₦2,000",
      destination_account: DESTINATION,
      // The bank's own name, not the Customer's spelling of it, so somebody who
      // typed "gtb" sees which institution this settled on before the PIN.
      destination_bank: OTHER_BANK,
      source_account: ACCOUNT,
    });
  });

  it("runs the name enquiry under the destination bank's code, before anything moves", async () => {
    await open(await askToSend());

    const enquiries = nameEnquiries();
    // The recipient's, at their bank. `ReceiverName` has no other source, and
    // the endpoint refuses a transfer without one.
    expect(enquiries[0]).toMatchObject({
      AccountNumber: DESTINATION,
      BankCode: OTHER_BANK_CODE,
    });
    // And the sender's, at this Bank, because BankOne validates `Payer` against
    // the sending account. Resolved before the Confirmation screen, so a
    // transfer that could not be built is refused before a PIN is asked for.
    expect(enquiries[1]).toMatchObject({ AccountNumber: ACCOUNT, BankCode: BANK_CODE });

    expect(harness.bankOne.transfers).toEqual([]);
  });

  it("speaks the inter-bank endpoint's own dialect", async () => {
    await submit(await askToSend(), { pin: PIN });

    const body = interBankRequest();
    // `Token` here, `AuthenticationKey` on the intra-bank endpoint — the same
    // value under two names, and each endpoint refuses the other's spelling.
    expect(body["Token"]).toBeDefined();
    expect(body["AuthenticationKey"]).toBeUndefined();

    // Everything NIBSS needs, none of it from anything a Customer typed.
    expect(body).toMatchObject({
      PayerAccountNumber: ACCOUNT,
      Payer: PAYER,
      ReceiverBankCode: OTHER_BANK_CODE,
      ReceiverAccountNumber: DESTINATION,
      ReceiverName: THERE,
      // The tier the recipient's own bank reported, rather than the lowest one
      // the adapter falls back to when it is told nothing.
      ReceiverKYC: "3",
    });
    // A stranger's national identifier is not forwarded, though the enquiry
    // that resolved their name would have given us one.
    expect(body["ReceiverBVN"]).toBe("");
  });

  it("sends both references, and asks the status query about the retrieval one", async () => {
    await start({ transfer: { dispatch: "pending", settles: "succeeded" } });
    await submit(await askToSend(), { pin: PIN });

    const body = interBankRequest();
    const retrieval = String(body["RetrievalReference"]);

    // BankOne rejects a retrieval reference longer than this, which rules out a
    // bare UUID; the transaction reference is required beside it, and the fake
    // refuses a transfer that arrives without one.
    expect(retrieval.length).toBeGreaterThan(0);
    expect(retrieval.length).toBeLessThanOrEqual(12);
    expect(harness.bankOne.transfers[0]?.transactionReference).toBeTruthy();

    // The value reused for the status query is the retrieval reference.
    expect(harness.bankOne.statusQueries).toContain(retrieval);

    // **Both fields carry that one value**, which is a decision rather than an
    // omission: BankOne's status query takes both names for one transfer, so two
    // different values would be two ways to ask about one debit and a later
    // question could be asked under the wrong one. It also means this half of
    // the requirement — *the retrieval reference is the one reused* — cannot be
    // falsified by a test, because there is no second value to reuse instead.
    expect(body["TransactionReference"]).toBe(retrieval);
  });
});

// --- Which endpoint, and what decides ---------------------------------------

describe("routing", () => {
  it("is decided from the bank code alone, with no Intent variant to carry it", async () => {
    // Two transfers, the same Intent kind, the same account number, the same
    // fields. The only thing that differs is the bank the Customer named, and
    // that becomes a code before anything else happens.
    await submit(await askToSend(OTHER_BANK), { pin: PIN });
    await submit(await askToSend(""), { pin: PIN });

    expect(harness.bankOne.transfers.map((sent) => sent.endpoint)).toEqual([
      "InterBankTransfer",
      "LocalFundsTransfer",
    ]);
    // And the two reached two different people, at two different banks, through
    // one Intent shape.
    expect(harness.bankOne.transfers[0]?.receiverName).toBe(THERE);
  });

  it("refuses a bank it cannot place, and asks BankOne nothing at all", async () => {
    harness.groq.setResolver(() => ({
      kind: "transfer_to_account",
      amount: AMOUNT,
      accountNumber: DESTINATION,
      bankName: "Zenit Bnk",
    }));
    await postWebhook(harness, saidPayload({ ...envelope, text: "send 2000 to 2124955312 at Zenit Bnk" }));
    const replies = await waitForReplies(harness, 1);

    // *Check the bank*, not *check the number* — the number may be perfect, and
    // a Customer told the wrong half retypes it until they give up.
    expect(replies.at(-1)).toContain("I do not recognise that bank");
    expect(nameEnquiries()).toEqual([]);
    expect(harness.bankOne.transfers).toEqual([]);
  });
});

// --- Three ways it can fail, and the Bank can tell them apart ---------------

describe("when the money does not move", () => {
  it("reports a 96 business failure as a failure", async () => {
    await start({ transfer: { dispatch: "fails", failureMessage: "Sender account name is not valid" } });

    const done = await submit(await askToSend(), { pin: PIN });

    expect(done.data["message"]).toContain("did not go through");
    expect(done.data["message"]).not.toContain("Sent");

    const settled = (await auditRows("mandate.settled"))[0];
    expect(settled?.outcome).toBe("failed");
    // Whose failure it was, in BankOne's own terms: `96` is somebody declining.
    expect(settled?.detail).toMatchObject({ result: "failed", responseCode: "96" });
  });

  it("tells a malformed request apart from it, though the Customer hears the same", async () => {
    await start({ transfer: { dispatch: "invalid" } });

    const done = await submit(await askToSend(), { pin: PIN });

    // The same true sentence: nothing moved, and it is not the Customer's
    // business whose fault that was.
    expect(done.data["message"]).toContain("did not go through");

    const settled = (await auditRows("mandate.settled"))[0];
    expect(settled?.outcome).toBe("failed");
    // `12` is the Middleware having sent something BankOne would not accept,
    // which is a defect of ours rather than a decline — and the audit row is
    // where the Bank finds out which of the two it was.
    expect(settled?.detail).toMatchObject({ result: "failed", responseCode: "12" });
  });

  it("does not call a dispatch nobody answered a failure", async () => {
    // The response never arrived, so the money may be gone. Told as neither
    // outcome, recorded as neither, and never retried — a second dispatch on a
    // request that did land is the double debit.
    await start({ transfer: { dispatch: "drops", settles: "never" } });

    const done = await submit(await askToSend(), { pin: PIN });

    expect(done.data["message"]).toContain("has not been confirmed yet");
    expect(done.data["message"]).not.toContain("did not go through");
    expect(harness.bankOne.transfers).toHaveLength(1);

    const settled = (await auditRows("mandate.settled"))[0];
    // `unavailable`, which is the audit table repeating what the Customer was
    // told: the platform does not know what happened to this money.
    expect(settled?.outcome).toBe("unavailable");
    expect(settled?.detail["responseCode"]).toBeUndefined();

    expect(await auditRows("handoff.triggered")).toHaveLength(1);
  });
});

// --- The audit trail ---------------------------------------------------------

describe("what the Bank can reconstruct afterwards", () => {
  it("records which endpoint carried it, and to which bank", async () => {
    await submit(await askToSend(), { pin: PIN });

    const dispatched = (await auditRows("mandate.dispatched"))[0];
    expect(dispatched?.detail).toMatchObject({
      route: "inter_bank",
      destinationBankCode: OTHER_BANK_CODE,
    });

    // Both name enquiries are recorded, and an investigator can tell which was
    // the recipient's and which was the payer's without inferring it from the
    // account numbers.
    // Newest first, the way the Dashboard shows them.
    const enquiries = await auditRows("banking.name_enquiry");
    expect(enquiries.map((row) => row.detail["subject"])).toEqual(["payer", "destination"]);
  });
});

/** The audit table, read the way the Dashboard reads it. */
const auditRows = async (
  action: string,
): Promise<readonly { outcome: string; detail: Record<string, unknown> }[]> => {
  const { token } = await harness.signInStaff("administrator");
  const response = await fetch(
    `${harness.middlewareUrl}/dashboard/audit?action=${encodeURIComponent(action)}&limit=50`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const body = (await response.json()) as {
    entries?: { action: string; outcome: string; detail: Record<string, unknown> }[];
  };
  return (body.entries ?? []).filter((entry) => entry.action === action);
};
