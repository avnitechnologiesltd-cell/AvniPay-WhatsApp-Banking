import type { Destination } from "./destinations";

/**
 * The Bank's identity API — the three endpoints BankOne cannot provide, plus
 * the one notification the auto-revoke rule needs, plus the one page to the
 * Bank's own operations desk that a stuck transfer sends.
 *
 * BankOne returns a name, a BVN and balances, and nothing that says where to
 * reach the person who owns the account or how to check a code they were sent.
 * So the Bank builds this to our published spec at
 * [`bank-identity-api.md`](../../../../docs/reference/bank-identity-api.md), and
 * the **Middleware is its only consumer** — a client here rather than in the
 * Platform is the whole of ADR-0006 in one file.
 *
 * The design decision that shapes every signature below: **the Bank's service
 * sends the code, and the platform never learns the contact.** Nothing in this
 * file returns a phone number or an email. It works in opaque handles and
 * Bank-chosen masked labels, and it could not leak a contact if it wanted to,
 * because it is never given one.
 */

export interface BankIdentityOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

/** Why the code was sent, so the Bank can word the message. */
export type OtpPurpose = "enrollment" | "renewal" | "pin_reset";

export type ResolveResult =
  | { readonly outcome: "resolved"; readonly destinations: readonly Destination[] }
  /** No such account, or one not in a state that permits enrollment. */
  | { readonly outcome: "not_found" }
  | { readonly outcome: "unavailable"; readonly reason: string };

/**
 * `expiresAt` is deliberately not carried out of here.
 *
 * The Bank generates the code, delivers it and **owns its expiry**. A copy of
 * that deadline on this side would be a second clock to disagree with theirs,
 * and the Customer's answer comes from `verify-otp` either way — which reports
 * an expired code as one more `rejected`, indistinguishable from a wrong one, as
 * it must be.
 */
export type SendCodeResult =
  | { readonly outcome: "sent" }
  /** The Bank knows this pair and declined it — an unknown handle, or its own rate limit. */
  | { readonly outcome: "refused"; readonly reason: string }
  | { readonly outcome: "unavailable"; readonly reason: string };

/**
 * `reason` is for the Middleware's logs and **never reaches the Customer**.
 * Wrong code, expired code and never-sent code are one message on the screen.
 */
export type VerifyCodeResult =
  | { readonly outcome: "verified" }
  | { readonly outcome: "rejected"; readonly reason: string }
  | { readonly outcome: "unavailable"; readonly reason: string };

/** What the Bank is asked to tell the contact on record about. */
export type NotifiableEvent = "binding_revoked_by_new_enrollment";

interface ResolveBody {
  destinations?: { id?: unknown; kind?: unknown; masked?: unknown }[];
}

interface VerifyBody {
  verified?: unknown;
  reason?: unknown;
}

export class BankIdentityClient {
  private readonly baseUrl: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  public constructor(private readonly options: BankIdentityOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /**
   * Account number in, somewhere to send a code out.
   *
   * A `404` is answered honestly by the Bank and swallowed here: the caller
   * shows a destination screen either way, from decoys. Half-implementing
   * enumeration resistance on both sides would be worse than a clean
   * implementation on one, and this is the side that has the lockout.
   */
  public async resolve(accountNumber: string, requestId: string): Promise<ResolveResult> {
    const answer = await this.post("/identity/resolve", { accountNumber }, requestId);
    if (answer.outcome === "unavailable") return answer;
    if (answer.status === 404) return { outcome: "not_found" };
    if (answer.status !== 200) {
      return { outcome: "unavailable", reason: `resolve answered HTTP ${answer.status}` };
    }

    const body = (answer.body ?? {}) as ResolveBody;
    const destinations = (body.destinations ?? [])
      .map((destination) => ({
        id: String(destination.id ?? ""),
        kind: destination.kind === "email" ? ("email" as const) : ("phone" as const),
        masked: String(destination.masked ?? ""),
      }))
      .filter((destination) => destination.id !== "" && destination.masked !== "");

    // A 200 with nowhere to send is the open question §7.2 asks the Bank: an
    // account with no contact on record has no enrollment path at all. Until
    // they answer, it is indistinguishable from an unknown account rather than
    // a dead end the Customer is told about.
    if (destinations.length === 0) return { outcome: "not_found" };

    return { outcome: "resolved", destinations };
  }

  public async sendCode(
    accountNumber: string,
    destinationId: string,
    purpose: OtpPurpose,
    requestId: string,
  ): Promise<SendCodeResult> {
    const answer = await this.post(
      "/identity/send-otp",
      { accountNumber, destinationId, purpose },
      requestId,
    );
    if (answer.outcome === "unavailable") return answer;

    if (answer.status >= 400 && answer.status < 500) {
      return { outcome: "refused", reason: `send-otp answered HTTP ${answer.status}` };
    }
    if (answer.status !== 200 && answer.status !== 202) {
      return { outcome: "unavailable", reason: `send-otp answered HTTP ${answer.status}` };
    }

    return { outcome: "sent" };
  }

  /**
   * The Bank verifies the code it issued, and **implements no lockout**. Attempt
   * counting is the platform's, because it is scoped to the WhatsApp number
   * rather than the Customer and is load-bearing for enumeration resistance.
   */
  public async verifyCode(
    accountNumber: string,
    destinationId: string,
    code: string,
    requestId: string,
  ): Promise<VerifyCodeResult> {
    const answer = await this.post(
      "/identity/verify-otp",
      { accountNumber, destinationId, code },
      requestId,
    );
    if (answer.outcome === "unavailable") return answer;
    if (answer.status !== 200) {
      return { outcome: "unavailable", reason: `verify-otp answered HTTP ${answer.status}` };
    }

    const body = (answer.body ?? {}) as VerifyBody;
    if (body.verified === true) return { outcome: "verified" };

    return {
      outcome: "rejected",
      reason: typeof body.reason === "string" ? body.reason : "incorrect",
    };
  }

  /**
   * Asks the Bank to tell the contact on record that something happened.
   *
   * The one endpoint beyond the original three, and it exists because the
   * auto-revoke rule needs it: enrolling an account on a new number kills the
   * old Binding in minutes rather than in ninety days, and the cost of that is a
   * SIM-swap attacker who can lock the real Customer out as a side effect.
   * **Notification is the mitigation** — it turns a silent takeover into one the
   * Customer can report — and the contact on record is the one address an
   * attacker holding the new handset does not control. The platform cannot send
   * it, because the platform does not know it.
   */
  public async notify(
    accountNumber: string,
    event: NotifiableEvent,
    requestId: string,
  ): Promise<{ readonly outcome: "sent" | "unavailable"; readonly reason?: string }> {
    const answer = await this.post("/identity/notify", { accountNumber, event }, requestId);
    if (answer.outcome === "unavailable") return answer;
    if (answer.status >= 200 && answer.status < 300) return { outcome: "sent" };

    return { outcome: "unavailable", reason: `notify answered HTTP ${answer.status}` };
  }

  /**
   * Pages the Bank's own operations desk. **Never a Customer.**
   *
   * Its one caller is Handoff trigger 1 — a transfer still `pending` past the
   * poll bound, which means money has left a Customer's account and nobody is
   * looking at it. It goes to an address the Bank configures in the Dashboard,
   * so it needs no approved template and draws on no WhatsApp messaging tier.
   *
   * Delivered through the Bank's notification service rather than by us, for the
   * plain reason that they run one and we do not: the platform holds no mail
   * transport, and inventing one to send a handful of alerts a month would be a
   * second delivery path to operate and monitor. The **address** is ours to hold
   * because the Bank set it here; the sending is theirs, as everything else on
   * this client already is.
   */
  public async alertOperations(
    address: string,
    subject: string,
    body: string,
    requestId: string,
  ): Promise<{ readonly outcome: "sent" | "unavailable"; readonly reason?: string }> {
    const answer = await this.post(
      "/identity/alert-operations",
      { address, subject, body },
      requestId,
    );
    if (answer.outcome === "unavailable") return answer;
    if (answer.status >= 200 && answer.status < 300) return { outcome: "sent" };

    return { outcome: "unavailable", reason: `alert-operations answered HTTP ${answer.status}` };
  }

  private async post(
    path: string,
    body: Readonly<Record<string, unknown>>,
    requestId: string,
  ): Promise<
    | { readonly outcome: "answered"; readonly status: number; readonly body: unknown }
    | { readonly outcome: "unavailable"; readonly reason: string }
  > {
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
          // Correlates one enrollment attempt across both parties' logs, which
          // is the only way to reconcile "we never sent it" with "it never
          // arrived" after the fact.
          "x-request-id": requestId,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      return {
        outcome: "unavailable",
        reason: error instanceof Error ? error.message : "the identity API could not be reached",
      };
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }

    return { outcome: "answered", status: response.status, body: parsed };
  }
}
