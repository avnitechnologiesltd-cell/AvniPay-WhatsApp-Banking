import { respondJson, startFake, type FakeListen, type FakeService } from "./server";

/**
 * The Bank's identity API, as `docs/reference/bank-identity-api.md` specifies
 * it — the one service on the seam that does not exist yet anywhere.
 *
 * It is a fake with opinions, and the opinions are the spec's:
 *
 * - **It returns `404` honestly** for an account it does not hold, and never
 *   invents a plausible-looking response. Enumeration resistance is the
 *   platform's job, and a half-implementation on both sides is worse than a
 *   clean one on either.
 * - **It never returns the account holder's name.** Account number in, real name
 *   out, with no verification, is a free enumeration oracle — and it is what the
 *   prior implementation did.
 * - **It implements no lockout**, because attempt counting is scoped to the
 *   WhatsApp number and the Bank cannot see one.
 * - **Its responses carry no contact detail** — an opaque handle and a masked
 *   label, and nothing a caller could reassemble a phone number from.
 */

export interface FakeIdentityDestination {
  readonly id: string;
  readonly kind: "phone" | "email";
  readonly masked: string;
}

export interface FakeIdentityAccount {
  readonly accountNumber: string;
  readonly destinations: readonly FakeIdentityDestination[];
  /** The code this account's holder will be sent. Fixed, so a test can type it. */
  readonly code?: string;
}

export interface FakeBankIdentityOptions {
  readonly apiKey: string;
  readonly accounts?: readonly FakeIdentityAccount[];
  /** Minutes a code lives. Ten, per the spec — not five; Nigerian SMS is slow. */
  readonly codeExpiryMinutes?: number;
  /**
   * Where to listen. Left alone by every test; set only when the Middleware is
   * in a container and has to reach this over the bridge — see `FakeListen`.
   */
  readonly listen?: FakeListen;
  /**
   * The code every account gets, including ones admitted on the fly.
   *
   * Separate from a seeded account's own `code` because `admitAnyAccount` has
   * no seeded account to copy one from — which is exactly how a runner that
   * announced `123456` went on sending the built-in default.
   */
  readonly code?: string;
  /**
   * Hold **any** account number asked about, rather than only the seeded ones.
   *
   * Off by default and off in every test, because the honest `404` is the
   * behaviour that matters: enumeration resistance is the platform's job, and a
   * fake that admits to everything would hide a platform that had stopped doing
   * it. On only when a human is driving a real handset and has not told this
   * service which account they hold — see `scripts/fake-bank-identity.mjs`.
   */
  readonly admitAnyAccount?: boolean;
}

export interface SentCode {
  readonly accountNumber: string;
  readonly destinationId: string;
  readonly purpose: string;
  readonly code: string;
}

export interface SentNotice {
  readonly accountNumber: string;
  readonly event: string;
}

/**
 * An alert the Bank's own operations desk was sent — **never a Customer**.
 *
 * The one caller is Handoff trigger 1: a transfer still `pending` past the poll
 * bound, which means a Customer's money has left and nobody is looking at it
 * until morning. It goes to an address the Bank configures, so it needs no
 * approved template and draws on no WhatsApp messaging tier.
 */
export interface SentOperationsAlert {
  readonly address: string;
  readonly subject: string;
  readonly body: string;
}

export interface FakeBankIdentity extends FakeService {
  /** Every code this service delivered, in order — the Customer's SMS inbox. */
  readonly codesSent: readonly SentCode[];
  /** Everything the Bank was asked to tell a contact on record about. */
  readonly noticesSent: readonly SentNotice[];
  /** Everything the Bank's operations desk was paged about. */
  readonly operationsAlerts: readonly SentOperationsAlert[];
  /**
   * Starts holding an account mid-test.
   *
   * Its use is the self-contradicting Bank: `resolve` 404s, the account then
   * appears, and `verify-otp` answers `verified: true` for something the Bank
   * has already said it does not hold.
   */
  readonly setAccount: (account: FakeIdentityAccount) => void;
  /**
   * Takes the whole service down, for the outage path.
   *
   * Worth a hook of its own because an outage is the one condition under which
   * enumeration resistance is easiest to get wrong: a step the real walk makes
   * and the decoy walk skips behaves differently the moment the Bank stops
   * answering, and that difference is an oracle for as long as it lasts.
   */
  readonly goDown: (down: boolean) => void;
}

const DEFAULT_CODE = "482913";

export const startFakeBankIdentity = async (
  options: FakeBankIdentityOptions,
): Promise<FakeBankIdentity> => {
  const accounts = new Map<string, FakeIdentityAccount>(
    (options.accounts ?? []).map((account) => [account.accountNumber, account]),
  );
  const codesSent: SentCode[] = [];
  const noticesSent: SentNotice[] = [];
  const operationsAlerts: SentOperationsAlert[] = [];
  const live = new Map<string, string>();
  const expiryMinutes = options.codeExpiryMinutes ?? 10;
  let down = false;

  const service = await startFake((request, response) => {
    if (request.headers["authorization"] !== `Bearer ${options.apiKey}`) {
      respondJson(response, 401, { error: "unauthorised" });
      return;
    }
    if (down) {
      respondJson(response, 500, { error: "the identity service is down" });
      return;
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const accountNumber = String(body["accountNumber"] ?? "");
    if (options.admitAnyAccount && accountNumber !== "" && !accounts.has(accountNumber)) {
      accounts.set(accountNumber, {
        accountNumber,
        code: options.code ?? options.accounts?.[0]?.code ?? DEFAULT_CODE,
        destinations: [
          { id: `${accountNumber}-phone`, kind: "phone", masked: "••• ••• 0000" },
          { id: `${accountNumber}-email`, kind: "email", masked: "a•••@example.com" },
        ],
      });
    }
    const account = accounts.get(accountNumber);

    if (request.path.endsWith("/identity/resolve")) {
      if (!account) {
        respondJson(response, 404, { error: "not_found" });
        return;
      }
      // No name, no customer identifier, no contact — a 200 means only "this
      // account exists and can be enrolled".
      respondJson(response, 200, { destinations: account.destinations });
      return;
    }

    if (request.path.endsWith("/identity/send-otp")) {
      const destinationId = String(body["destinationId"] ?? "");
      const known = account?.destinations.some((destination) => destination.id === destinationId);
      if (!account || !known) {
        respondJson(response, 400, { error: "unknown destination" });
        return;
      }

      const code = account.code ?? DEFAULT_CODE;
      live.set(`${accountNumber}:${destinationId}`, code);
      codesSent.push({
        accountNumber,
        destinationId,
        purpose: String(body["purpose"] ?? ""),
        code,
      });

      // The response carries neither the code nor the contact.
      respondJson(response, 202, {
        sent: true,
        expiresAt: new Date(Date.now() + expiryMinutes * 60_000).toISOString(),
      });
      return;
    }

    if (request.path.endsWith("/identity/verify-otp")) {
      const destinationId = String(body["destinationId"] ?? "");
      const key = `${accountNumber}:${destinationId}`;
      const expected = live.get(key);

      if (expected === undefined) {
        respondJson(response, 200, { verified: false, reason: "not_sent" });
        return;
      }
      if (String(body["code"] ?? "") !== expected) {
        // No attempt counting here, deliberately. The platform owns the lockout.
        respondJson(response, 200, { verified: false, reason: "incorrect" });
        return;
      }

      // Single-use: a successful verification invalidates the code.
      live.delete(key);
      respondJson(response, 200, { verified: true });
      return;
    }

    // To the **Bank**, not to a Customer. No account is named and none is
    // looked up — the address is one the Bank configured in the Dashboard, and
    // this endpoint exists because the platform does not run a mail server and
    // the Bank's notification service already does.
    if (request.path.endsWith("/identity/alert-operations")) {
      const address = String(body["address"] ?? "");
      if (!address) {
        respondJson(response, 400, { error: "an address is required" });
        return;
      }
      operationsAlerts.push({
        address,
        subject: String(body["subject"] ?? ""),
        body: String(body["body"] ?? ""),
      });
      respondJson(response, 202, { sent: true });
      return;
    }

    if (request.path.endsWith("/identity/notify")) {
      if (!account) {
        respondJson(response, 404, { error: "not_found" });
        return;
      }
      noticesSent.push({ accountNumber, event: String(body["event"] ?? "") });
      respondJson(response, 202, { sent: true });
      return;
    }

    respondJson(response, 404, { error: `no fake for ${request.path}` });
  }, options.listen ?? {});

  return {
    ...service,
    codesSent,
    noticesSent,
    operationsAlerts,
    setAccount: (account) => accounts.set(account.accountNumber, account),
    goDown: (next) => {
      down = next;
    },
  };
};
