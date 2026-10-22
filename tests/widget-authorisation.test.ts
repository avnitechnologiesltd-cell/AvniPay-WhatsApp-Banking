import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { saidPayload, signInAppIdentity } from "@avni/fakes";

import {
  BANK_CODE,
  PHONE_NUMBER_ID,
  exchangeFlow,
  exchangeInApp,
  exchangeWidgetSurface,
  flowTokenFrom,
  openInApp,
  postWebhook,
  startHarness,
  waitForReplies,
  type Harness,
  type HarnessOptions,
  type IssuedSnippet,
} from "./harness";

/**
 * **The Widget's authorisation surfaces** — everything a WhatsApp Flow renders,
 * rendered inside the Bank's own application instead.
 *
 * Driven the way the Widget drives it: the conversation goes through the
 * Platform's versioned edge, and the moment a sealed surface opens, every
 * exchange goes **straight to the Middleware** at the address the Middleware
 * named ([ADR-0007](../docs/adr/0007-flow-confirmations-terminate-at-the-middleware.md)).
 *
 * Two of the tests below carry more weight than the rest. One completes a
 * transfer, PIN and all, **with the Platform stopped** — which is the only way
 * to assert that the secret does not pass through it rather than that it happens
 * not to today. The other asserts that a token minted for WhatsApp cannot be
 * authorised here, because this door has neither Meta's signature nor a keypair
 * in front of it.
 */

const ACCOUNT = "0123456789";
const WHATSAPP_NUMBER = "2348012345678";
const DESTINATION = "2124955312";
const SECOND_DESTINATION = "3037777771";
const RECIPIENT = "CHIDI EZE";
const OTHER_RECIPIENT = "MUSA BELLO";
const PIN = "4821";
const AMOUNT = 2000;

let harness: Harness;
let snippet: IssuedSnippet;

const start = async (options: HarnessOptions = {}): Promise<void> => {
  harness = await startHarness({
    accounts: [{ accountNumber: ACCOUNT, availableBalance: 250_000 }],
    names: [
      { accountNumber: DESTINATION, bankCode: BANK_CODE, name: RECIPIENT },
      { accountNumber: SECOND_DESTINATION, bankCode: BANK_CODE, name: OTHER_RECIPIENT },
    ],
    ...options,
  });
  snippet = await harness.generateSnippet();
};

afterEach(async () => {
  await harness?.stop();
});

// --- Driving it --------------------------------------------------------------

/** An envelope for `account`, signed by the Bank's backend, good for an hour. */
const identityFor = (account = ACCOUNT): string =>
  signInAppIdentity(snippet.secret, {
    accountNumber: account,
    expiresAt: new Date(harness.clock.now().getTime() + 60 * 60 * 1000),
  });

/** A Customer already signed in to the Bank's application, in chat. */
const signedIn = async (account = ACCOUNT): Promise<string> => {
  const opened = await openInApp(harness, identityFor(account));
  if (!opened.conversationId) throw new Error(`The Customer was refused: ${opened.outcome}`);
  return opened.conversationId;
};

/** What the Orchestration Layer extracted. Shape guaranteed, values never. */
const saysTransfer = (amount: number, accountNumber: string): void => {
  harness.groq.setResolver(() => ({
    kind: "transfer_to_account",
    amount,
    accountNumber,
    bankName: "",
  }));
};

const saysSendTo = (amount: number, beneficiaryName: string): void => {
  harness.groq.setResolver(() => ({ kind: "transfer_to_beneficiary", amount, beneficiaryName }));
};

const saysForget = (beneficiaryName: string): void => {
  harness.groq.setResolver(() => ({ kind: "forget_beneficiary", beneficiaryName }));
};

/** A sealed surface, as the Widget receives it — three strings and a caption. */
interface OfferedSurface {
  readonly verb: string;
  readonly purpose: string;
  readonly token: string;
  readonly flowId: string;
  readonly surfaceUrl: string;
  readonly callToAction: string;
}

const saidInApp = async (conversationId: string, said: string): Promise<OfferedSurface> => {
  const { reply } = await exchangeInApp(harness, { conversationId, said });
  return reply as unknown as OfferedSurface;
};

/** Asks to send money in the Bank's app, and comes back holding the surface. */
const askToSend = async (
  conversationId: string,
  amount = AMOUNT,
  accountNumber = DESTINATION,
): Promise<OfferedSurface> => {
  saysTransfer(amount, accountNumber);
  return saidInApp(conversationId, `send ${amount} to ${accountNumber}`);
};

/** Opens the surface, exactly as tapping the button in the Widget does. */
const openSurface = (surface: OfferedSurface) =>
  exchangeWidgetSurface(surface.surfaceUrl, { token: surface.token, action: "INIT" });

const submitScreen = (
  surface: OfferedSurface,
  screen: string,
  data: Readonly<Record<string, unknown>>,
) =>
  exchangeWidgetSurface(surface.surfaceUrl, {
    token: surface.token,
    action: "data_exchange",
    screen,
    data,
  });

/** The Confirmation screen, filled in the way a Customer fills it in. */
const enterPin = (surface: OfferedSurface, pin = PIN, extra: Record<string, unknown> = {}) =>
  submitScreen(surface, "CONFIRM", { pin, pin_confirmation: "", save_as: "", ...extra });

const transferSent = () => harness.bankOne.transfers.at(-1);

const auditRows = async (
  action: string,
): Promise<{ outcome: string; detail: Record<string, unknown> }[]> => {
  const { token } = await harness.signInStaff("administrator");
  const response = await fetch(`${harness.middlewareUrl}/dashboard/audit?action=${action}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const { entries } = (await response.json()) as {
    entries: { outcome: string; detail: Record<string, unknown> }[];
  };
  return entries;
};

/** Walks one whole transfer, so a later one has somebody saved to resolve. */
const completeTransfer = async (
  conversationId: string,
  destination: string,
  saveAs: string,
): Promise<void> => {
  const surface = await askToSend(conversationId, AMOUNT, destination);
  await openSurface(surface);
  const done = await enterPin(surface, PIN, { save_as: saveAs });
  if (done.screen !== "DONE") {
    throw new Error(`The transfer did not complete: ${JSON.stringify(done)}`);
  }
};

// --- The journey -------------------------------------------------------------

describe("a Customer transfers from in-app chat", () => {
  beforeEach(async () => {
    await start();
    await harness.seedPin(ACCOUNT, PIN);
  });

  it("says it in their own words and is offered a surface, not a sentence", async () => {
    const conversationId = await signedIn();

    const surface = await askToSend(conversationId);

    expect(surface.verb).toBe("secure");
    expect(surface.callToAction).toBe("Review and send");
    // **The words beside the button say nothing about the transfer.** The
    // Platform was never told the amount or who is being paid.
    expect(surface.purpose).not.toContain(RECIPIENT);
    expect(surface.purpose).not.toContain("2,000");
  });

  it("sees the amount, the destination and the name that account is in", async () => {
    const conversationId = await signedIn();
    const surface = await askToSend(conversationId);

    const confirmation = await openSurface(surface);

    expect(confirmation.screen).toBe("CONFIRM");
    expect(confirmation.data).toMatchObject({
      amount: "₦2,000",
      destination_name: RECIPIENT,
      destination_account: DESTINATION,
      source_account: ACCOUNT,
    });
    // This Customer has a PIN, so the screen takes one rather than asking them
    // to choose one — and says so by carrying nothing about it, which keeps
    // this payload identical to the one a published Flow already reads.
    expect(confirmation.data["pin_action"]).toBeUndefined();
  });

  it("enters their PIN and the money moves", async () => {
    const conversationId = await signedIn();
    const surface = await askToSend(conversationId);
    await openSurface(surface);

    const done = await enterPin(surface);

    expect(done.terminal).toBe(true);
    expect(done.data["message"]).toContain(`Sent ₦2,000 to ${RECIPIENT}.`);
    expect(transferSent()).toMatchObject({ toAccountNumber: DESTINATION, amount: AMOUNT });
  });

  it("is told the outcome in the same conversation, and never over WhatsApp", async () => {
    // The last screen is rendered into the panel the Customer was already
    // typing in, so it is still there when they come back to look. A second
    // sentence over WhatsApp would be addressed to a handle that names no
    // correspondent at all.
    const conversationId = await signedIn();
    const surface = await askToSend(conversationId);
    await openSurface(surface);

    const done = await enterPin(surface);

    expect(done.data["message"]).toContain("Sent ₦2,000");
    expect(harness.whatsapp.sent).toHaveLength(0);
  });

  it("sends to somebody they have paid before, by name", async () => {
    const conversationId = await signedIn();
    await completeTransfer(conversationId, DESTINATION, "Chidi");

    saysSendTo(500, "Chidi");
    const surface = await saidInApp(conversationId, "send 500 to Chidi");
    const confirmation = await openSurface(surface);

    // One match goes straight to the Confirmation screen — through a fresh name
    // enquiry, because the saved name is not evidence of who holds it now.
    expect(confirmation.screen).toBe("CONFIRM");
    expect(confirmation.data).toMatchObject({ amount: "₦500", destination_name: RECIPIENT });
  });

  it("chooses between two people wearing the same name, on the handset", async () => {
    const conversationId = await signedIn();
    await completeTransfer(conversationId, DESTINATION, "Musa");
    await completeTransfer(conversationId, SECOND_DESTINATION, "Musa");

    saysSendTo(500, "Musa");
    const surface = await saidInApp(conversationId, "send 500 to Musa");
    const choosing = await openSurface(surface);

    expect(choosing.screen).toBe("RECIPIENT");
    const rows = choosing.data["beneficiaries"] as { id: string; description: string }[];
    expect(rows).toHaveLength(2);
    // The bank's own name for each account is on every row, because it is the
    // thing a Customer recognises.
    expect(rows.map((row) => row.description).join(" ")).toContain(OTHER_RECIPIENT);

    const chosen = rows.find((row) => row.description.includes(OTHER_RECIPIENT));
    const confirmation = await submitScreen(surface, "RECIPIENT", {
      beneficiary_id: chosen?.id,
    });

    expect(confirmation.data).toMatchObject({ destination_name: OTHER_RECIPIENT });
    const done = await enterPin(surface);
    expect(transferSent()).toMatchObject({ toAccountNumber: SECOND_DESTINATION, amount: 500 });
    expect(done.data["message"]).toContain(`Sent ₦500 to ${OTHER_RECIPIENT}.`);
  });

  it("lands on the account-number form when nobody is saved, which is their first transfer", async () => {
    const conversationId = await signedIn();

    saysSendTo(500, "Musa");
    const surface = await saidInApp(conversationId, "send 500 to Musa");
    const choosing = await openSurface(surface);

    expect(choosing.screen).toBe("RECIPIENT");
    expect(choosing.data["beneficiaries"]).toEqual([]);

    const confirmation = await submitScreen(surface, "RECIPIENT", {
      account_number: DESTINATION,
      bank_name: "",
    });

    expect(confirmation.data).toMatchObject({ destination_name: RECIPIENT, amount: "₦500" });
  });

  it("removes a saved recipient by tapping them", async () => {
    const conversationId = await signedIn();
    await completeTransfer(conversationId, DESTINATION, "Chidi");

    saysForget("Chidi");
    const surface = await saidInApp(conversationId, "forget Chidi");
    const choosing = await openSurface(surface);

    expect(choosing.data).toMatchObject({ purpose: "forget" });
    const rows = choosing.data["beneficiaries"] as { id: string }[];

    const done = await submitScreen(surface, "RECIPIENT", { beneficiary_id: rows[0]?.id });

    expect(done.terminal).toBe(true);
    expect(done.data["message"]).toContain("no longer saved");
  });
});

describe("the same screens as the Flow, driven by the same logic", () => {
  beforeEach(async () => {
    await start();
    await harness.seedPin(ACCOUNT, PIN);
    // One account, reachable both ways. Opening the Bank's app does not disturb
    // a WhatsApp Binding, so this is an ordinary state rather than a contrived
    // one — and it is what lets the two screens be compared as equal rather
    // than as equivalent.
    await harness.seedBinding(WHATSAPP_NUMBER, ACCOUNT);
  });

  /**
   * **What a screen actually says**, with the published Flow's packaging taken
   * off.
   *
   * The two Channels are not byte-identical and should not be: a published Flow
   * validates against a declared data model, so the WhatsApp path pads every
   * screen to the full set of keys and adds a `has_*` boolean per key for
   * `visible` to bind to. None of that is a word a Customer reads.
   *
   * So the property under test is the one that matters — **the same words, the
   * same amounts, the same rows** — rather than the same JSON. A different
   * amount, a missing row or a changed name still fails, which is the whole
   * reason these two tests exist.
   */
  const wordsOf = (data: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(data).filter(
        ([key, value]) =>
          !key.startsWith("has_") &&
          value !== "" &&
          !(Array.isArray(value) && value.length === 0),
      ),
    );

  /** The Confirmation screen as WhatsApp renders it, for the same transfer. */
  const confirmationOverWhatsApp = async (): Promise<Record<string, unknown>> => {
    saysTransfer(AMOUNT, DESTINATION);
    await postWebhook(
      harness,
      saidPayload({
        phoneNumberId: PHONE_NUMBER_ID,
        from: WHATSAPP_NUMBER,
        text: `send ${AMOUNT} to ${DESTINATION}`,
      }),
    );
    await waitForReplies(harness);

    const opened = await exchangeFlow(harness, {
      version: "3.0",
      action: "INIT",
      screen: "",
      data: {},
      flow_token: flowTokenFrom(harness),
    });
    return opened.data;
  };

  it("puts the same words on the Confirmation screen on both Channels", async () => {
    const overWhatsApp = await confirmationOverWhatsApp();

    const conversationId = await signedIn();
    const surface = await askToSend(conversationId);
    const inApp = await openSurface(surface);

    expect(inApp.screen).toBe("CONFIRM");
    expect(wordsOf(inApp.data)).toEqual(wordsOf(overWhatsApp));
  });

  it("puts the same rows on the Disambiguation screen on both Channels", async () => {
    const conversationId = await signedIn();
    await completeTransfer(conversationId, DESTINATION, "Musa");
    await completeTransfer(conversationId, SECOND_DESTINATION, "Musa");

    saysSendTo(500, "Musa");
    const surface = await saidInApp(conversationId, "send 500 to Musa");
    const inApp = await openSurface(surface);

    await postWebhook(
      harness,
      saidPayload({ phoneNumberId: PHONE_NUMBER_ID, from: WHATSAPP_NUMBER, text: "send 500 to Musa" }),
    );
    await waitForReplies(harness);
    const overWhatsApp = await exchangeFlow(harness, {
      version: "3.0",
      action: "INIT",
      screen: "",
      data: {},
      flow_token: flowTokenFrom(harness),
    });

    expect(inApp.screen).toBe("RECIPIENT");
    expect(overWhatsApp.screen).toBe("RECIPIENT");
    expect(wordsOf(inApp.data)).toEqual(wordsOf(overWhatsApp.data));
  });
});

describe("a Customer who has never enrolled sets a PIN at their first transfer", () => {
  beforeEach(async () => {
    // No `seedPin`, on purpose. This account has never enrolled, because in-app
    // chat has no enrollment — which is the whole reason this surface exists.
    await start();
  });

  it("is asked to choose one, and no code is sent to anybody", async () => {
    const conversationId = await signedIn();
    const surface = await askToSend(conversationId);

    const confirmation = await openSurface(surface);

    expect(confirmation.data).toMatchObject({ pin_action: "create" });
    expect(confirmation.data["pin_note"]).toContain("4-digit Transaction PIN");
    // **No OTP.** The Bank's own application has already authenticated them,
    // which is the step an enrollment code would otherwise supply.
    expect(harness.bankIdentity.codesSent).toHaveLength(0);
  });

  it("is told when the two do not match, and nothing moves", async () => {
    const conversationId = await signedIn();
    const surface = await askToSend(conversationId);
    await openSurface(surface);

    const again = await submitScreen(surface, "CONFIRM", {
      pin: PIN,
      pin_confirmation: "9999",
      save_as: "",
    });

    expect(again.screen).toBe("CONFIRM");
    expect(again.data["error_message"]).toBe("Those two PINs are not the same.");
    expect(harness.bankOne.transfers).toHaveLength(0);
  });

  it("is told when it is not four digits", async () => {
    const conversationId = await signedIn();
    const surface = await askToSend(conversationId);
    await openSurface(surface);

    const again = await submitScreen(surface, "CONFIRM", {
      pin: "12",
      pin_confirmation: "12",
      save_as: "",
    });

    expect(again.data["error_message"]).toContain("4 digits");
    expect(harness.bankOne.transfers).toHaveLength(0);
  });

  it("chooses one, and the transfer goes through in the same step", async () => {
    const conversationId = await signedIn();
    const surface = await askToSend(conversationId);
    await openSurface(surface);

    const done = await submitScreen(surface, "CONFIRM", {
      pin: PIN,
      pin_confirmation: PIN,
      save_as: "",
    });

    expect(done.data["message"]).toContain(`Sent ₦2,000 to ${RECIPIENT}.`);
    expect(transferSent()).toMatchObject({ toAccountNumber: DESTINATION, amount: AMOUNT });
    expect(harness.bankIdentity.codesSent).toHaveLength(0);
  });

  it("keeps the PIN they chose, and is asked to enter it next time", async () => {
    const conversationId = await signedIn();
    const first = await askToSend(conversationId);
    await openSurface(first);
    await submitScreen(first, "CONFIRM", { pin: PIN, pin_confirmation: PIN, save_as: "" });

    const second = await askToSend(conversationId, 500, SECOND_DESTINATION);
    const confirmation = await openSurface(second);

    expect(confirmation.data["pin_action"]).toBeUndefined();
    expect(confirmation.data["pin_note"]).toBeUndefined();

    const wrong = await enterPin(second, "9999");
    expect(wrong.data["error_message"]).toContain("That PIN is not right.");

    const done = await enterPin(second, PIN);
    expect(done.data["message"]).toContain(`Sent ₦500 to ${OTHER_RECIPIENT}.`);
  });

  it("records that a PIN was set, and never what it was", async () => {
    const conversationId = await signedIn();
    const surface = await askToSend(conversationId);
    await openSurface(surface);
    await submitScreen(surface, "CONFIRM", { pin: PIN, pin_confirmation: PIN, save_as: "" });

    const rows = await auditRows("pin.set");

    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail["reason"]).toContain("first transfer");
    expect(JSON.stringify(rows)).not.toContain(PIN);
  });
});

describe("the Widget posts to the Middleware, and never through the Platform", () => {
  beforeEach(async () => {
    await start();
    await harness.seedPin(ACCOUNT, PIN);
  });

  it("is handed the Middleware's address, not the address it was served from", async () => {
    const conversationId = await signedIn();

    const surface = await askToSend(conversationId);

    expect(surface.surfaceUrl.startsWith(harness.middlewareUrl)).toBe(true);
    expect(surface.surfaceUrl.startsWith(harness.platformUrl)).toBe(false);
  });

  it("finishes the transfer with the Platform stopped", async () => {
    // **The assertion this whole slice exists for.** If the PIN or the "Save
    // as" label went through the Platform, there would be nowhere for them to
    // go — the conversation opened there, and everything after the button is
    // somewhere else entirely.
    const conversationId = await signedIn();
    const surface = await askToSend(conversationId);

    await harness.stopPlatform();

    const confirmation = await openSurface(surface);
    expect(confirmation.data).toMatchObject({ destination_name: RECIPIENT });

    const done = await enterPin(surface, PIN, { save_as: "Chidi" });

    expect(done.data["message"]).toContain(`Sent ₦2,000 to ${RECIPIENT}.`);
    expect(transferSent()).toMatchObject({ toAccountNumber: DESTINATION, amount: AMOUNT });
  });

  it("saves the label the Customer typed inside the surface, and never records it", async () => {
    const conversationId = await signedIn();
    await completeTransfer(conversationId, DESTINATION, "Chidi");

    // It reached the store, which is the only thing a label is for.
    saysSendTo(500, "Chidi");
    const surface = await saidInApp(conversationId, "send 500 to Chidi");
    expect((await openSurface(surface)).screen).toBe("CONFIRM");

    // And it is nowhere in the table the Bank looks at during an investigation.
    // The row says whether there **was** a label, never the label.
    const saved = await auditRows("beneficiary.saved");
    expect(saved[0]?.detail).toMatchObject({ labelled: true });
    expect(JSON.stringify(saved)).not.toContain("Chidi");
  });

  it("keeps the words the model sees free of it too", async () => {
    const conversationId = await signedIn();
    await completeTransfer(conversationId, DESTINATION, "Chidi");

    // The label is captured inside the sealed surface, so the one
    // Customer-typed string the resolver later searches never passes through
    // the layer that reads Customer text into a model.
    expect(JSON.stringify(harness.groq.calls)).not.toContain("Chidi");
  });
});

describe("the payload rule holds identically here", () => {
  beforeEach(async () => {
    await start();
    await harness.seedPin(ACCOUNT, PIN);
  });

  it("ignores a tampered amount, account number and name on the Confirmation screen", async () => {
    // The ₦900,000 attack, on the other Channel. The handset owns this payload
    // entirely; what stops it is that nothing reads a rendered value out of it.
    const conversationId = await signedIn();
    const surface = await askToSend(conversationId);
    await openSurface(surface);

    const done = await enterPin(surface, PIN, {
      amount: "₦900,000",
      destination_account: SECOND_DESTINATION,
      destination_name: OTHER_RECIPIENT,
      source_account: SECOND_DESTINATION,
    });

    expect(done.data["message"]).toContain(`Sent ₦2,000 to ${RECIPIENT}.`);
    expect(transferSent()).toMatchObject({
      toAccountNumber: DESTINATION,
      fromAccountNumber: ACCOUNT,
      amount: AMOUNT,
    });
  });

  it("ignores a tampered amount on the Disambiguation screen", async () => {
    const conversationId = await signedIn();
    saysSendTo(500, "Musa");
    const surface = await saidInApp(conversationId, "send 500 to Musa");
    await openSurface(surface);

    const confirmation = await submitScreen(surface, "RECIPIENT", {
      account_number: DESTINATION,
      bank_name: "",
      amount: "₦900,000",
    });

    // Read back from the walk this token names, never from what came up.
    expect(confirmation.data).toMatchObject({ amount: "₦500" });
  });

  it("refuses a Mandate a second time, however the payload is dressed", async () => {
    const conversationId = await signedIn();
    const surface = await askToSend(conversationId);
    await openSurface(surface);
    await enterPin(surface);

    const again = await enterPin(surface);

    expect(again.screen).toBe("UNAVAILABLE");
    expect(harness.bankOne.transfers).toHaveLength(1);
  });
});

describe("the surface belongs to the Channel that opened it", () => {
  beforeEach(async () => {
    await start();
    await harness.seedPin(ACCOUNT, PIN);
    await harness.seedBinding(WHATSAPP_NUMBER, ACCOUNT);
  });

  it("refuses a WhatsApp token, because this door has no signature in front of it", async () => {
    // The escalation this check exists for. A Flow's payload is signed and
    // encrypted by Meta; this endpoint is plain HTTP on the open internet, so
    // a token that could be authorised through both would have made the weaker
    // door the only one that matters.
    saysTransfer(AMOUNT, DESTINATION);
    await postWebhook(
      harness,
      saidPayload({
        phoneNumberId: PHONE_NUMBER_ID,
        from: WHATSAPP_NUMBER,
        text: `send ${AMOUNT} to ${DESTINATION}`,
      }),
    );
    await waitForReplies(harness);
    const whatsappToken = flowTokenFrom(harness);

    // The address is public and a handset could reach it either way; what it
    // may drive is not.
    const conversationId = await signedIn();
    const mine = await askToSend(conversationId);

    const refused = await exchangeWidgetSurface(mine.surfaceUrl, {
      token: whatsappToken,
      action: "data_exchange",
      screen: "CONFIRM",
      data: { pin: PIN, pin_confirmation: "", save_as: "" },
    });

    expect(refused.screen).toBe("UNAVAILABLE");
    expect(harness.bankOne.transfers).toHaveLength(0);

    const rows = await auditRows("surface.refused");
    expect(rows[0]).toMatchObject({
      outcome: "refused",
      detail: { surface: "widget", reason: "that surface belongs to another Channel" },
    });
  });

  it("refuses an in-app token at the Flows door too, because the argument is symmetric", async () => {
    // Meta's signature makes reaching that endpoint hard rather than
    // impossible, and a rule that held in one direction only because the other
    // door happened to be harder would be resting on an app secret staying
    // secret forever.
    const conversationId = await signedIn();
    const surface = await askToSend(conversationId);

    const refused = await exchangeFlow(harness, {
      version: "3.0",
      action: "data_exchange",
      screen: "CONFIRM",
      data: { pin: PIN },
      flow_token: surface.token,
    });

    expect(refused.screen).toBe("UNAVAILABLE");
    expect(harness.bankOne.transfers).toHaveLength(0);

    // And the surface itself is untouched: the Customer's own door still works.
    await openSurface(surface);
    expect((await enterPin(surface)).data["message"]).toContain(`Sent ₦2,000 to ${RECIPIENT}.`);
  });

  it("answers a token nobody minted with the same sentence", async () => {
    const conversationId = await signedIn();
    const surface = await askToSend(conversationId);

    const refused = await exchangeWidgetSurface(surface.surfaceUrl, {
      token: "a-token-nobody-minted",
      action: "INIT",
    });

    expect(refused).toMatchObject({ screen: "UNAVAILABLE", terminal: true });
    expect(refused.data["message"]).toBe((await openSurfaceWithNoToken(surface)).data["message"]);
  });

  it("answers a body it cannot parse with the same sentence", async () => {
    const conversationId = await signedIn();
    const surface = await askToSend(conversationId);

    const response = await fetch(surface.surfaceUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: 7 }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ screen: "UNAVAILABLE", terminal: true });
  });

  it("lets a browser in a WebView we do not own reach it at all", async () => {
    // The Widget is served by the Platform and posts here, so every one of
    // these requests is cross-origin by construction. Without this the whole
    // separation is a design nobody can ship.
    const conversationId = await signedIn();
    const surface = await askToSend(conversationId);

    const preflight = await fetch(surface.surfaceUrl, {
      method: "OPTIONS",
      headers: { origin: "null", "access-control-request-method": "POST" },
    });

    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("content-type");
  });

  const openSurfaceWithNoToken = (surface: OfferedSurface) =>
    exchangeWidgetSurface(surface.surfaceUrl, { action: "INIT" });
});

describe("a forgotten PIN, on a Channel that never enrolled one", () => {
  beforeEach(async () => {
    await start();
    await harness.seedBinding(WHATSAPP_NUMBER, ACCOUNT);
  });

  it("is answered honestly rather than with a sentence about a phone number", async () => {
    // Inherited from ticket 34 and closed here. In-app chat has no OTP path, so
    // there is nothing to reset — and the answer the Customer used to get was
    // WhatsApp's, about a number they never mentioned.
    const conversationId = await signedIn();
    harness.groq.setResolver(() => ({ kind: "reset_pin" }));

    const { reply } = await exchangeInApp(harness, { conversationId, said: "I forgot my PIN" });

    // And it hands them to a human, because there is no code path to a new PIN
    // where nothing was ever enrolled. It used to end *"reply HELP"* instead,
    // and HELP reached nobody.
    expect(reply?.["text"]).toContain(
      "You choose your Transaction PIN the first time you send money here.",
    );
    expect(reply?.["text"]).toContain("passing you to a member of our team");
  });

  it("still opens the code path for a Customer who does have a Binding", async () => {
    // The other half. The WhatsApp sentence keeps its diagnostic value, because
    // the reason is now the Middleware's to state rather than the Platform's to
    // infer from what was asked for.
    harness.groq.setResolver(() => ({ kind: "reset_pin" }));
    await postWebhook(
      harness,
      saidPayload({ phoneNumberId: PHONE_NUMBER_ID, from: WHATSAPP_NUMBER, text: "I forgot my PIN" }),
    );
    await waitForReplies(harness);

    const [sent] = harness.whatsapp.sent;
    expect(sent?.type).toBe("interactive");
  });

  it("tells an unlinked number that it is unlinked, in the words it always did", async () => {
    harness.groq.setResolver(() => ({ kind: "reset_pin" }));
    await postWebhook(
      harness,
      saidPayload({ phoneNumberId: PHONE_NUMBER_ID, from: "2348099999999", text: "reset my pin" }),
    );

    // The greeting, because this number has no Binding — the same answer any
    // stranger gets, whatever they said. The Widget's own unlinked wording is
    // unchanged and is asserted above; this is WhatsApp's door.
    expect(await waitForReplies(harness)).toEqual([
      expect.stringContaining("Do you have a bank account"),
    ]);
  });
});

describe("reads stay silent on this Channel", () => {
  beforeEach(async () => {
    await start();
    await harness.seedPin(ACCOUNT, PIN);
  });

  it("answers a balance in words, with no surface, no PIN and no Mandate", async () => {
    const conversationId = await signedIn();

    const { reply } = await exchangeInApp(harness, { conversationId, said: "what's my balance" });

    expect(reply).toEqual({ verb: "say", text: "Your available balance is ₦250,000." });
    expect(await auditRows("transfer.proposed")).toEqual([]);
    expect(await auditRows("pin.checked")).toEqual([]);
  });
});
