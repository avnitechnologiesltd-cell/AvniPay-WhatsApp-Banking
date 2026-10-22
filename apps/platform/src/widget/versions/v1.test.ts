import { describe, expect, it } from "vitest";

import { WIDGET_V1_SOURCE } from "./v1";

/**
 * The Widget's authorisation surfaces, **executed**.
 *
 * `tests/widget-authorisation.test.ts` drives the Middleware the way a handset
 * does and proves what the Middleware will and will not accept. It cannot prove
 * what this file *sends*, because it builds the payloads itself — and the two
 * claims this slice rests on are claims about exactly that:
 *
 * - the sealed surface posts to the **Middleware**, at the address on the
 *   reply, and never to the Platform endpoint the chat above it uses;
 * - the payload carries **only what the Customer typed**, and never a value the
 *   server rendered.
 *
 * Both are invisible from the seam and both fail silently: a Widget that
 * echoed `amount` back would pass every journey test in the repository, because
 * the Middleware ignores it. So this runs the real source against a small fake
 * DOM and reads what it asked for — the same exception, on the same grounds, as
 * the loader next door.
 */

// --- A tiny DOM ------------------------------------------------------------

interface FakeElement {
  tagName: string;
  className: string;
  textContent: string;
  value: string;
  disabled: boolean;
  readonly children: FakeElement[];
  parentNode: FakeElement | undefined;
  appendChild: (child: FakeElement) => FakeElement;
  removeChild: (child: FakeElement) => FakeElement;
  setAttribute: (name: string, value: string) => void;
  onclick?: () => void;
  onsubmit?: (event: { preventDefault: () => void }) => void;
  [key: string]: unknown;
}

const element = (tagName: string): FakeElement => {
  const children: FakeElement[] = [];
  let text = "";

  const node = {
    tagName,
    className: "",
    value: "",
    disabled: false,
    children,
    parentNode: undefined,
    appendChild: (child: FakeElement) => {
      child.parentNode = node;
      children.push(child);
      return child;
    },
    removeChild: (child: FakeElement) => {
      const at = children.indexOf(child);
      if (at >= 0) children.splice(at, 1);
      child.parentNode = undefined;
      return child;
    },
    setAttribute: () => undefined,
    scrollTop: 0,
    scrollHeight: 0,
  } as unknown as FakeElement;

  // Setting `textContent` replaces the children, as it does in a real DOM. The
  // Widget clears the surface that way on every repaint, and a fake that kept
  // the old children would let a stale screen's fields be read as the new one's.
  Object.defineProperty(node, "textContent", {
    get: () => text,
    set: (value: string) => {
      text = value;
      children.length = 0;
    },
  });

  return node;
};

const descendants = (node: FakeElement): FakeElement[] =>
  node.children.flatMap((child) => [child, ...descendants(child)]);

const withClass = (root: FakeElement, className: string): FakeElement[] =>
  descendants(root).filter((node) => node.className === className);

const texts = (root: FakeElement): string[] =>
  descendants(root)
    .map((node) => node.textContent)
    .filter((value) => value.length > 0);

// --- Running the Widget ----------------------------------------------------

interface Call {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

const PLATFORM = "https://app.bank.example";
const MIDDLEWARE = "https://middleware.bank.example";
const SURFACE_URL = `${MIDDLEWARE}/widget/surface`;
const TOKEN = "a-token-only-the-middleware-can-read";

const SECURE = {
  verb: "secure",
  purpose: "Check the details and enter your Transaction PIN to send this.",
  token: TOKEN,
  flowId: "a-published-flow",
  surfaceUrl: SURFACE_URL,
  callToAction: "Review and send",
};

const CONFIRM = {
  screen: "CONFIRM",
  terminal: false,
  data: {
    amount: "₦2,000",
    destination_name: "CHIDI EZE",
    destination_account: "2124955312",
    destination_bank: "Example MFB",
    source_account: "0123456789",
    fee_note: "Fees apply per your account tariff.",
  },
};

const DONE = {
  screen: "DONE",
  terminal: true,
  data: { message: "Sent ₦2,000 to CHIDI EZE. Reference abc123." },
};

interface Running {
  readonly mount: FakeElement;
  readonly calls: Call[];
  /** Types a message and submits it, the way a Customer does. */
  readonly say: (text: string) => Promise<void>;
  /** Taps the first control with this label. */
  readonly tap: (label: string) => Promise<void>;
  readonly settle: () => Promise<void>;
}

/** Lets every queued promise run, which is how the Widget makes progress. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
};

const run = (answers: (call: Call) => unknown): Running => {
  const mount = element("div");
  const calls: Call[] = [];

  const fetch = (url: string, init: { body: string }) => {
    const call: Call = { url, body: JSON.parse(init.body) as Record<string, unknown> };
    calls.push(call);
    return Promise.resolve({ ok: true, json: () => Promise.resolve(answers(call)) });
  };

  const document = { createElement: element, head: element("head") };
  const window = {
    AvniChat: { version: "v1", base: PLATFORM, identity: "v1.payload.signature", mount },
  };

  new Function("window", "document", "fetch", WIDGET_V1_SOURCE)(window, document, fetch);

  const controls = (label: string): FakeElement[] =>
    descendants(mount).filter(
      (node) => node.tagName === "button" && node.textContent === label,
    );

  return {
    mount,
    calls,
    say: async (text) => {
      const form = descendants(mount).find((node) => node.className === "avni-chat__composer");
      const input = descendants(mount).find((node) => node.className === "avni-chat__input");
      if (!form || !input) throw new Error("The Widget did not draw a composer");
      input.value = text;
      form.onsubmit?.({ preventDefault: () => undefined });
      await settle();
    },
    tap: async (label) => {
      const [button] = controls(label);
      if (!button) throw new Error(`No control says "${label}"`);
      button.onclick?.();
      await settle();
    },
    settle,
  };
};

/** Answers the Platform's two routes, and the surface from a queue. */
const answering = (screens: unknown[]) => {
  const queue = [...screens];
  return (call: Call): unknown => {
    if (call.url.endsWith("/conversations")) {
      return { outcome: "opened", conversationId: "8f14e45f-ceea-467a-9bbf-8ba1f2e0a1a1" };
    }
    if (call.url.endsWith("/messages")) return { reply: SECURE };
    return queue.shift() ?? DONE;
  };
};

const surfaceCalls = (widget: Running): Call[] =>
  widget.calls.filter((call) => call.url === SURFACE_URL);

const platformCalls = (widget: Running): Call[] =>
  widget.calls.filter((call) => call.url.startsWith(PLATFORM));

// --- What it sends ---------------------------------------------------------

describe("the sealed surface posts to the Middleware", () => {
  it("opens it at the address on the reply, not at the address it was served from", async () => {
    const widget = run(answering([CONFIRM]));
    await settle();
    await widget.say("send 2000 to 2124955312");

    await widget.tap("Review and send");

    expect(surfaceCalls(widget)).toHaveLength(1);
    expect(surfaceCalls(widget)[0]?.body).toMatchObject({ token: TOKEN, action: "INIT" });
    // Everything before the button went to the Platform; nothing after it did.
    expect(platformCalls(widget).map((call) => call.url)).toEqual([
      `${PLATFORM}/widget/v1/conversations`,
      `${PLATFORM}/widget/v1/messages`,
    ]);
  });

  it("sends the Transaction PIN and the label to the Middleware and nowhere else", async () => {
    const widget = run(answering([CONFIRM, DONE]));
    await settle();
    await widget.say("send 2000 to 2124955312");
    await widget.tap("Review and send");

    fill(widget, "Transaction PIN", "4821");
    fill(widget, "Save as (optional)", "Chidi");
    await widget.tap("Send");

    const submitted = surfaceCalls(widget).at(-1);
    expect(submitted?.body).toMatchObject({
      token: TOKEN,
      action: "data_exchange",
      screen: "CONFIRM",
      data: { pin: "4821", pin_confirmation: "", save_as: "Chidi" },
    });
    // Not in one request to the Platform, of any shape, at any point.
    expect(JSON.stringify(platformCalls(widget))).not.toContain("4821");
    expect(JSON.stringify(platformCalls(widget))).not.toContain("Chidi");
  });

  it("sends back nothing the server rendered", async () => {
    // **The payload rule, from this side.** The Middleware ignores a tampered
    // `amount`, so a Widget that echoed one would pass every journey test in
    // the repository and still be handing the phone a say in what is agreed to.
    const widget = run(answering([CONFIRM, DONE]));
    await settle();
    await widget.say("send 2000 to 2124955312");
    await widget.tap("Review and send");

    fill(widget, "Transaction PIN", "4821");
    await widget.tap("Send");

    const sent = surfaceCalls(widget).at(-1)?.body as { data: Record<string, unknown> };
    expect(Object.keys(sent.data).sort()).toEqual(["pin", "pin_confirmation", "save_as"]);
    expect(JSON.stringify(sent)).not.toContain("₦2,000");
    expect(JSON.stringify(sent)).not.toContain("CHIDI EZE");
    expect(JSON.stringify(sent)).not.toContain("2124955312");
  });

  it("returns a tapped row's id, and only that", async () => {
    const choosing = {
      screen: "RECIPIENT",
      terminal: false,
      data: {
        purpose: "transfer",
        amount: "₦500",
        beneficiaries: [
          { id: "row-1", title: "Musa", description: "MUSA BELLO · Example MFB ••••7771" },
          { id: "row-2", title: "Musa", description: "CHIDI EZE · Example MFB ••••5312" },
        ],
      },
    };
    const widget = run(answering([choosing, CONFIRM]));
    await settle();
    await widget.say("send 500 to Musa");
    await widget.tap("Review and send");

    const rows = withClass(widget.mount, "avni-chat__row");
    expect(rows).toHaveLength(2);
    rows[1]?.onclick?.();
    await settle();

    expect(surfaceCalls(widget).at(-1)?.body).toMatchObject({
      screen: "RECIPIENT",
      data: { beneficiary_id: "row-2" },
    });
    expect(surfaceCalls(widget).at(-1)?.body).not.toMatchObject({ data: { amount: "₦500" } });
  });
});

describe("what a Customer sees", () => {
  it("shows the amount, the recipient and the name that account is in", async () => {
    const widget = run(answering([CONFIRM]));
    await settle();
    await widget.say("send 2000 to 2124955312");

    await widget.tap("Review and send");

    const shown = texts(widget.mount).join(" | ");
    expect(shown).toContain("₦2,000");
    expect(shown).toContain("CHIDI EZE");
    expect(shown).toContain("Fees apply per your account tariff.");
  });

  it("says both names when the account has been renamed since it was saved", async () => {
    const renamed = {
      ...CONFIRM,
      data: { ...CONFIRM.data, name_changed: "This account is now CHIDI EZE. It was Musa when you saved it." },
    };
    const widget = run(answering([renamed]));
    await settle();
    await widget.say("send 2000 to 2124955312");

    await widget.tap("Review and send");

    expect(withClass(widget.mount, "avni-chat__surface-warning")[0]?.textContent).toContain(
      "It was Musa when you saved it.",
    );
  });

  it("asks a Customer with no PIN for two fields, and says so", async () => {
    const creating = {
      ...CONFIRM,
      data: {
        ...CONFIRM.data,
        pin_action: "create",
        pin_note: "Choose a 4-digit Transaction PIN. You will use it every time you send money.",
      },
    };
    const widget = run(answering([creating, DONE]));
    await settle();
    await widget.say("send 2000 to 2124955312");
    await widget.tap("Review and send");

    expect(texts(widget.mount).join(" | ")).toContain("Choose a 4-digit Transaction PIN");

    fill(widget, "Choose a Transaction PIN", "4821");
    fill(widget, "Enter it again", "4821");
    await widget.tap("Set PIN and send");

    expect(surfaceCalls(widget).at(-1)?.body).toMatchObject({
      data: { pin: "4821", pin_confirmation: "4821", save_as: "" },
    });
  });

  it("closes the surface on a terminal screen and leaves the outcome in the conversation", async () => {
    const widget = run(answering([CONFIRM, DONE]));
    await settle();
    await widget.say("send 2000 to 2124955312");
    await widget.tap("Review and send");

    fill(widget, "Transaction PIN", "4821");
    await widget.tap("Send");

    // The panel the Customer was already typing in is where the outcome lands,
    // and the surface is gone rather than left showing a spent Mandate.
    expect(withClass(widget.mount, "avni-chat__surface")).toHaveLength(0);
    expect(texts(widget.mount)).toContain("Sent ₦2,000 to CHIDI EZE. Reference abc123.");
  });

  it("closes it with a plain sentence when the Middleware cannot be reached", async () => {
    const mount = element("div");
    const fetch = (url: string) =>
      url.startsWith(MIDDLEWARE)
        ? Promise.reject(new Error("network"))
        : Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve(
                url.endsWith("/messages")
                  ? { reply: SECURE }
                  : { outcome: "opened", conversationId: "c" },
              ),
          });
    const document = { createElement: element, head: element("head") };
    const window = {
      AvniChat: { version: "v1", base: PLATFORM, identity: "v1.payload.signature", mount },
    };
    new Function("window", "document", "fetch", WIDGET_V1_SOURCE)(window, document, fetch);
    await settle();

    const form = descendants(mount).find((node) => node.className === "avni-chat__composer");
    const input = descendants(mount).find((node) => node.className === "avni-chat__input");
    if (!form || !input) throw new Error("The Widget did not draw a composer");
    input.value = "send 2000 to 2124955312";
    form.onsubmit?.({ preventDefault: () => undefined });
    await settle();

    const [button] = descendants(mount).filter((node) => node.textContent === "Review and send");
    button?.onclick?.();
    await settle();

    expect(withClass(mount, "avni-chat__surface")).toHaveLength(0);
    expect(texts(mount)).toContain("Chat is not available right now. Please try again shortly.");
  });
});

/** Types into the field under this label, the way a Customer does. */
const fill = (widget: Running, label: string, value: string): void => {
  const field = withClass(widget.mount, "avni-chat__field").find(
    (node) => node.children[0]?.textContent === label,
  );
  const input = field?.children[1];
  if (!input) throw new Error(`No field is labelled "${label}"`);
  input.value = value;
};
