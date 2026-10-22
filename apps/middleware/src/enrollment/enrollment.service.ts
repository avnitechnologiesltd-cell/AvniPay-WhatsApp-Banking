import { randomUUID } from "node:crypto";

import { Inject, Injectable, Logger } from "@nestjs/common";

import type { MiddlewareConfig } from "@avni/config";
import type { SurfaceNotApplicable } from "@avni/intent";
import { CLOCK, type Clock } from "@avni/service";

import type { AuditOutcome } from "../audit/actions";
import { AuditRepository } from "../audit/audit.repository";
import { BindingsRepository, isDormant } from "../identity/bindings.repository";
import { NotificationsService } from "../notifications/notifications.service";
import { TransactionPinService } from "../pin/transaction-pin.service";
import { PINS_DIFFER, pinProblem } from "../pin/transaction-pin";
import { SURFACE_UNAVAILABLE } from "../flows/screen";
import { hashSecret } from "../secrets/argon2";
import { BANK_IDENTITY_CLIENT, MIDDLEWARE_CONFIG } from "../tokens";
import { BankIdentityClient, type OtpPurpose } from "./bank-identity.client";
import { asFlowOption, decoyDestinations, type Destination } from "./destinations";
import { EnrollmentRepository, type EnrollmentSession } from "./enrollment.repository";
import { isWellFormedNuban } from "./nuban";

/**
 * The front door, lifted from the enrollment prototype's state machine.
 *
 * The shape is: an account number identifies, a **code to a contact already on
 * record** authenticates, and a **Transaction PIN** finishes. The Bank's service
 * sends the code and the platform never learns the contact — every destination
 * below is an opaque handle and a masked label the Bank chose.
 *
 * ## The three rules that are easy to write and easy to get wrong
 *
 * **One failure message.** A wrong account number, a wrong code, an expired code
 * and a code that was never sent are one sentence to the Customer. Distinguish
 * any of them and the whole thing is an enumeration oracle: type an account
 * number, read the error, learn whether it exists. The audit table is where the
 * four are told apart, and it is the only place.
 *
 * **The silent walk has to be complete.** An account the Bank returns `404` for
 * still gets a destination screen with plausible destinations, still gets a code
 * screen with the same countdown, and still fails with the same words. Stopping
 * short at any of those is the oracle again in a different costume.
 *
 * **The check digit comes first.** All of the above is cruel to a Customer who
 * mistyped one digit, so the NUBAN check runs before anything leaves the
 * platform and tells them plainly to look again.
 *
 * ## And one that is easy to under-read
 *
 * **Enrollment is not complete until the PIN is set.** A Binding with no PIN can
 * read a balance and authorise nothing, so the Binding and the PIN are written
 * in one transaction at the last step. Abandoning at the PIN screen leaves
 * nothing behind, which is the only reading of "you are linked" that is true.
 */

/** A screen for the handset, rendered by whichever sealed surface asked. */
export interface EnrollmentScreen {
  readonly screen:
    | "IDENTIFY"
    | "CHOOSE_DESTINATION"
    | "CODE"
    | "SET_PIN"
    | "DONE"
    | "LOCKED"
    | "UNAVAILABLE";
  readonly data: Readonly<Record<string, unknown>>;
  /** Terminal screens end the Flow; nothing follows them. */
  readonly terminal: boolean;
}

export type BeginResult =
  | { readonly outcome: "started"; readonly token: string; readonly purpose: OtpPurpose }
  | { readonly outcome: "locked_out"; readonly until: Date }
  /**
   * Nothing to do — already linked, or asking to reset a PIN with no Binding.
   *
   * **A code, not a sentence.** The words belong to the Platform, which is the
   * only layer that renders any; the reason belongs here, which is the only
   * layer that knows one. It lives in `@avni/intent` beside the outcome union,
   * so both deployables compile against one closed set rather than agree by
   * inspection.
   */
  | { readonly outcome: "not_applicable"; readonly reason: SurfaceNotApplicable };

/** What the Customer is asked to do, in the words they will see. */
export const ENROLLMENT_WORDS = {
  malformedAccount: "That does not look like one of our account numbers. Please check it.",
  /**
   * **The one failure message.** It says nothing about which of the four things
   * went wrong, and no branch below is allowed to add to it.
   */
  wrongCode: "That code is not right.",
  attemptsLeft: (left: number) => `${left} ${left === 1 ? "attempt" : "attempts"} left.`,
  lockedOut: "Too many attempts. Please try again in an hour.",
  unavailable: SURFACE_UNAVAILABLE,
  /** Shared with the Widget's PIN-creation screen, which sets one too. */
  pinsDiffer: PINS_DIFFER,
  /**
   * The last screen of the walk, and it says one thing: it worked.
   *
   * What a Customer can now *do* is said in the conversation a moment later,
   * beside the menu that does it — a list of capabilities on a screen the
   * Customer is about to close is a list nobody can act on.
   */
  linked: (bankName: string) => `🎉 Congratulations! Your ${bankName} account is now connected.`,
  renewed: "Your WhatsApp banking is active again.",
  pinChanged: "Your Transaction PIN has been changed.",
} as const;

/** 3 attempts, then an hour, on the WhatsApp number. The Bank implements none. */
const CODE_ATTEMPTS = 3;
const LOCKOUT_MS = 60 * 60 * 1000;

/**
 * How long a half-finished walk can be picked up again.
 *
 * The flow token is a bearer credential living on a handset, and a session left
 * at the PIN screen is one that has already passed the code. Thirty minutes is
 * comfortably longer than the Bank's ten-minute code and short enough that an
 * abandoned enrollment is not a standing invitation.
 */
const SESSION_LIFETIME_MS = 30 * 60 * 1000;

@Injectable()
export class EnrollmentService {
  private readonly logger = new Logger(EnrollmentService.name);

  public constructor(
    @Inject(EnrollmentRepository) private readonly enrollments: EnrollmentRepository,
    @Inject(BindingsRepository) private readonly bindings: BindingsRepository,
    @Inject(TransactionPinService) private readonly pins: TransactionPinService,
    @Inject(BANK_IDENTITY_CLIENT) private readonly identity: BankIdentityClient,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(MIDDLEWARE_CONFIG) private readonly config: MiddlewareConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // --- Getting in ------------------------------------------------------------

  /**
   * Mints the sealed surface a Customer walks.
   *
   * **Which walk it is, is decided here rather than asked for.** A number with
   * no Binding enrolls; a number whose Binding has gone quiet for ninety days
   * renews, which costs one screen rather than the whole front door and does not
   * re-set the PIN.
   */
  public async begin(channelIdentity: string, want: "link" | "pin_reset"): Promise<BeginResult> {
    const locked = await this.lockedOut(channelIdentity);
    if (locked) return { outcome: "locked_out", until: locked };

    const existing = await this.bindings.findLiveByChannelIdentity(channelIdentity);
    const dormant =
      existing !== undefined &&
      isDormant(existing, this.clock.now(), this.config.enrollment.bindingDormancyDays);

    let purpose: OtpPurpose;
    if (want === "pin_reset") {
      if (!existing || dormant) {
        return { outcome: "not_applicable", reason: "no_binding" };
      }
      purpose = "pin_reset";
    } else if (existing && dormant) {
      purpose = "renewal";
    } else if (existing) {
      return { outcome: "not_applicable", reason: "already_linked" };
    } else {
      purpose = "enrollment";
    }

    // An enrollment identifies from what the Customer types. A renewal and a PIN
    // reset identify from the Binding they already hold, which is what makes
    // them one screen shorter and is the whole of the difference.
    const from =
      purpose === "enrollment" || !existing
        ? {}
        : { accountNumber: existing.accountNumber, bindingId: existing.id };
    const started = await this.enrollments.start(channelIdentity, purpose, from);

    await this.record("enrollment.started", "succeeded", {
      ...(from.accountNumber ? { accountNumber: from.accountNumber } : {}),
      detail: { purpose },
    });

    return { outcome: "started", token: started.token, purpose };
  }

  // --- The screens -----------------------------------------------------------

  /**
   * The first screen, and the one a `BACK` lands on.
   *
   * An unrecognised token is answered with the unavailable screen and nothing
   * else. Expired, forged and finished are one answer for the same reason every
   * failure below is.
   */
  public async open(token: string | undefined): Promise<EnrollmentScreen> {
    const session = await this.session(token);
    if (!session) return this.unavailable();

    const locked = await this.lockedOut(session.channelIdentity);
    if (locked) return this.locked();

    switch (session.phase) {
      case "identifying":
        return { screen: "IDENTIFY", data: {}, terminal: false };

      case "choosing_destination":
        return this.offerDestinations(session);

      case "awaiting_code":
        return { screen: "CODE", data: {}, terminal: false };

      case "setting_pin":
        return { screen: "SET_PIN", data: {}, terminal: false };

      case "complete":
        return this.unavailable();
    }
  }

  /**
   * The account number, checked locally before anything leaves the platform.
   *
   * A `404` from the Bank does not stop here, and does not look different from a
   * `200`. It is recorded, and the walk continues on decoys.
   */
  public async submitAccount(
    token: string | undefined,
    accountNumber: string,
  ): Promise<EnrollmentScreen> {
    const session = await this.session(token);
    if (!session || session.phase !== "identifying") return this.unavailable();

    const locked = await this.lockedOut(session.channelIdentity);
    if (locked) return this.locked();

    const typed = accountNumber.trim();
    if (!isWellFormedNuban(this.config.enrollment.nubanBankCode, typed)) {
      // No bank call, and no attempt spent. Without this, one mistyped digit
      // costs the Customer the entire silent walk and an hour's lockout, for a
      // mistake the platform could see from where it stood.
      await this.record("enrollment.account_submitted", "refused", {
        detail: { reason: "failed the NUBAN check digit", purpose: session.purpose },
      });
      return {
        screen: "IDENTIFY",
        data: { error_message: ENROLLMENT_WORDS.malformedAccount },
        terminal: false,
      };
    }

    const requestId = randomUUID();
    const resolved = await this.identity.resolve(typed, requestId);

    if (resolved.outcome === "unavailable") {
      this.logger.error({ event: "identity_api_unavailable", reason: resolved.reason });
      await this.record("enrollment.account_submitted", "unavailable", {
        accountNumber: typed,
        requestId,
        detail: { reason: resolved.reason },
      });
      return this.unavailable();
    }

    const exists = resolved.outcome === "resolved";
    await this.enrollments.update(session.id, {
      accountNumber: typed,
      accountExists: exists,
      phase: "choosing_destination",
    });

    // The audit table is the only place these two are distinguishable. The
    // Customer's screens from here on are byte-identical.
    await this.record("enrollment.account_submitted", exists ? "succeeded" : "refused", {
      accountNumber: typed,
      requestId,
      detail: {
        purpose: session.purpose,
        reason: exists ? "the Bank holds this account" : "the Bank does not hold this account",
      },
    });

    return this.offerDestinations(
      { ...session, accountNumber: typed, accountExists: exists },
      resolved.outcome === "resolved" ? resolved.destinations : undefined,
    );
  }

  /**
   * The Customer picks where the code goes, and it is sent — or, on the decoy
   * walk, nothing is sent and the screen says exactly the same thing.
   */
  public async chooseDestination(
    token: string | undefined,
    destinationId: string,
  ): Promise<EnrollmentScreen> {
    const session = await this.session(token);
    if (!session?.accountNumber || session.phase !== "choosing_destination") {
      return this.unavailable();
    }

    const locked = await this.lockedOut(session.channelIdentity);
    if (locked) return this.locked();

    // **Asked for on both walks, and that symmetry is the point.** Skipping the
    // call for an account the Bank 404'd would look like a saving and is an
    // oracle: the moment the Bank's service is down, a real account gets *try
    // again shortly* and an unknown one walks on to the code screen, and an
    // attacker can tell them apart for as long as the outage lasts. Making the
    // same call at the same step means the outage looks identical from both.
    //
    // It costs no traffic a real enrollment would not have spent, and it reveals
    // nothing new to the Bank — `resolve` already told them which account number
    // was offered.
    const requestId = randomUUID();
    const sent = await this.identity.sendCode(
      session.accountNumber,
      destinationId,
      session.purpose,
      requestId,
    );

    if (sent.outcome === "unavailable") {
      this.logger.error({ event: "identity_api_unavailable", reason: sent.reason });
      await this.record("enrollment.code_sent", "unavailable", {
        accountNumber: session.accountNumber,
        requestId,
        detail: { reason: sent.reason },
      });
      return this.unavailable();
    }

    // A refusal — an unknown account, an unknown handle, the Bank's own rate
    // limit — is swallowed. The Customer walks on to a code screen and fails
    // there with the one message, because a destination screen that can say
    // "no" is a destination screen that confirms which destinations are real.
    await this.record("enrollment.code_sent", sent.outcome === "sent" ? "succeeded" : "refused", {
      accountNumber: session.accountNumber,
      requestId,
      detail: {
        purpose: session.purpose,
        ...(sent.outcome === "refused" ? { reason: sent.reason } : {}),
      },
    });

    await this.enrollments.update(session.id, { destinationId, phase: "awaiting_code" });

    return { screen: "CODE", data: {}, terminal: false };
  }

  /**
   * The code, and the only place an attempt is spent.
   *
   * The counter is on the **WhatsApp number**, not on this walk. Closing the
   * Flow and reopening it does not buy three more guesses.
   */
  public async submitCode(
    token: string | undefined,
    code: string,
  ): Promise<EnrollmentScreen> {
    const session = await this.session(token);
    if (!session?.accountNumber || session.phase !== "awaiting_code") return this.unavailable();

    const locked = await this.lockedOut(session.channelIdentity);
    if (locked) return this.locked();

    const requestId = randomUUID();
    // Checked on both walks, for the reason `chooseDestination` sets out: a step
    // one walk makes and the other skips is a step that behaves differently when
    // the Bank is down.
    const checked = await this.identity.verifyCode(
      session.accountNumber,
      session.destinationId ?? "",
      code.trim(),
      requestId,
    );

    if (checked.outcome === "unavailable") {
      // A Bank outage must not spend a Customer's attempt. Three of those and
      // they are locked out of a failure that was never theirs.
      this.logger.error({ event: "identity_api_unavailable", reason: checked.reason });
      await this.record("enrollment.code_checked", "unavailable", {
        accountNumber: session.accountNumber,
        requestId,
        detail: { reason: checked.reason },
      });
      return this.unavailable();
    }

    // **`accountExists` is checked again here, and it is not redundant.** The
    // Bank told us it does not hold this account; a later `verified: true` for
    // the same account contradicts that, and the two together are a Bank bug or
    // a compromised identity service. Either way it must not mint a Binding to
    // an account nobody has confirmed exists, so the platform's own earlier
    // reading wins.
    const verified = checked.outcome === "verified" && session.accountExists;
    const cause =
      checked.outcome === "rejected"
        ? checked.reason
        : verified
          ? ""
          : "the Bank verified a code for an account it does not hold";

    if (!verified) return this.failCode(session, cause, requestId);

    await this.enrollments.clearFailures(session.channelIdentity);
    await this.record("enrollment.code_checked", "succeeded", {
      accountNumber: session.accountNumber,
      requestId,
      detail: { purpose: session.purpose },
    });

    // A renewal is finished here. It proves the number still belongs to the same
    // person and says nothing about the PIN, so it does not ask for one.
    if (session.purpose === "renewal") {
      if (session.bindingId) await this.bindings.renew(session.bindingId);
      await this.enrollments.complete(session.id);
      await this.record("enrollment.completed", "succeeded", {
        accountNumber: session.accountNumber,
        detail: { purpose: "renewal" },
      });
      return { screen: "DONE", data: { message: ENROLLMENT_WORDS.renewed }, terminal: true };
    }

    await this.enrollments.update(session.id, { phase: "setting_pin" });
    return { screen: "SET_PIN", data: {}, terminal: false };
  }

  /**
   * The last step, and the one that makes "you are linked" true.
   *
   * For an enrollment the Binding and the PIN are written together. For a reset
   * only the PIN moves — the Binding is already there and untouched.
   */
  public async setPin(
    token: string | undefined,
    pin: string,
    confirmation: string,
  ): Promise<EnrollmentScreen> {
    const session = await this.session(token);
    if (!session?.accountNumber || session.phase !== "setting_pin") return this.unavailable();

    const problem = pinProblem(pin);
    if (problem) {
      return { screen: "SET_PIN", data: { error_message: problem }, terminal: false };
    }
    if (pin !== confirmation) {
      return {
        screen: "SET_PIN",
        data: { error_message: ENROLLMENT_WORDS.pinsDiffer },
        terminal: false,
      };
    }

    if (session.purpose === "pin_reset") {
      await this.pins.set(session.accountNumber, pin, { reason: "reset over the code path" });
      await this.enrollments.complete(session.id);
      await this.record("enrollment.completed", "succeeded", {
        accountNumber: session.accountNumber,
        detail: { purpose: "pin_reset" },
      });
      return { screen: "DONE", data: { message: ENROLLMENT_WORDS.pinChanged }, terminal: true };
    }

    // Hashed before the transaction opens: argon2id is deliberately slow, and
    // holding a write lock across it would be paying that cost twice.
    const pinHash = await hashSecret(pin);
    const bound = await this.bindings.bind(session.channelIdentity, session.accountNumber, {
      pinHash,
    });

    await this.audit.record({
      action: "pin.set",
      actor: { kind: "customer" },
      outcome: "succeeded",
      accountNumber: session.accountNumber,
      detail: { reason: "set at the end of enrollment" },
    });

    await this.enrollments.complete(session.id);
    await this.record("enrollment.completed", "succeeded", {
      accountNumber: session.accountNumber,
      detail: { purpose: "enrollment", revokedBindings: bound.revoked.length },
    });

    // Told afterwards, and never allowed to fail the enrollment: a Customer
    // whose phone was stolen must be able to link the replacement even if
    // WhatsApp or the Bank's notification service is unreachable.
    for (const displaced of bound.revoked) {
      if (displaced.channelIdentity === session.channelIdentity) continue;
      await this.notifications.bindingRevokedByNewEnrollment(
        displaced.channelIdentity,
        displaced.accountNumber,
        randomUUID(),
      );
    }

    // The conversation gets the welcome and the menu; this screen just says it
    // worked.
    //
    // **Awaited, and still best-effort.** Awaiting is what keeps the two
    // messages ahead of whatever the Customer does next — fire-and-forget lets
    // them land after the reply to a later message, which reads as the platform
    // talking over itself. The catch is what keeps a linked Customer linked
    // whether or not WhatsApp accepted them.
    await this.notifications
      .enrollmentCompleted(session.channelIdentity, session.accountNumber ?? "", this.config.bankName)
      .catch((error: unknown) => {
        this.logger.warn(
          `enrollment.welcome_failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

    return {
      screen: "DONE",
      data: { message: ENROLLMENT_WORDS.linked(this.config.bankName) },
      terminal: true,
    };
  }

  // --- The parts every screen leans on ---------------------------------------

  /**
   * The walk this token names, if it is still live.
   *
   * Expired, forged, finished and never-minted are one answer. A caller that
   * could tell them apart has an oracle, and none of the four is a state a real
   * handset reaches.
   */
  private async session(token: string | undefined): Promise<EnrollmentSession | undefined> {
    const session = await this.enrollments.findByToken(token);
    if (!session) return undefined;

    const age = this.clock.now().getTime() - session.startedAt.getTime();
    return age > SESSION_LIFETIME_MS ? undefined : session;
  }

  /**
   * Where the decoys come in.
   *
   * A real account shows what the Bank returned; an unknown one shows a list
   * derived deterministically from the account number and a Middleware-side key.
   * Deterministic because two probes of the same number that differed would be
   * the oracle; keyed because a list anyone could compute would be too.
   */
  private async offerDestinations(
    session: EnrollmentSession,
    known?: readonly Destination[],
  ): Promise<EnrollmentScreen> {
    const accountNumber = session.accountNumber ?? "";
    let destinations: readonly Destination[];

    if (known) {
      destinations = known;
    } else {
      // A resume or a `BACK`, so the list is fetched again rather than kept.
      // Nothing about a Customer's contacts is stored between screens — masked
      // or not, that is a contact detail and the platform holds none.
      //
      // Asked for on both walks, again for symmetry under an outage.
      const resolved = await this.identity.resolve(accountNumber, randomUUID());
      if (resolved.outcome === "unavailable") return this.unavailable();
      destinations =
        resolved.outcome === "resolved"
          ? resolved.destinations
          : decoyDestinations(this.config.enrollment.decoySecret, accountNumber);
    }

    return {
      screen: "CHOOSE_DESTINATION",
      // The account holder's name is not here, and there is no screen on which
      // it is. One confirmation screen before the code succeeds and the whole
      // thing is void — account number in, real name out, is what the prior
      // implementation did and it is a free enumeration oracle.
      //
      // `masked` is rendered as `title` because that is the field a Flow's
      // `RadioButtonsGroup` binds to, and a published Flow cannot rename a
      // field on its way in. The mapping is here, at the screen boundary,
      // rather than in `Destination` — the Bank's masked label is the domain
      // term and every other reader keeps it.
      data: { destinations: destinations.map(asFlowOption) },
      terminal: false,
    };
  }

  private async failCode(
    session: EnrollmentSession,
    cause: string,
    requestId: string,
  ): Promise<EnrollmentScreen> {
    const { failedAttempts } = await this.enrollments.lockoutFor(session.channelIdentity);
    const spentBefore = failedAttempts;
    const willLock = spentBefore + 1 >= CODE_ATTEMPTS;
    const until = willLock ? new Date(this.clock.now().getTime() + LOCKOUT_MS) : null;
    const spent = await this.enrollments.recordFailure(session.channelIdentity, spentBefore, until);

    await this.record("enrollment.code_checked", "refused", {
      accountNumber: session.accountNumber ?? undefined,
      requestId,
      // The cause is written here and said nowhere else. Without this row nobody
      // — not a Support Officer, not an investigator — can ever tell a Customer
      // who mistyped their account number from one who mistyped the code.
      detail: { reason: cause, purpose: session.purpose, attemptsSpent: spent },
    });

    if (until) {
      await this.audit.record({
        action: "enrollment.locked_out",
        actor: { kind: "customer" },
        outcome: "refused",
        ...(session.accountNumber ? { accountNumber: session.accountNumber } : {}),
        detail: { attempts: spent, untilMinutes: LOCKOUT_MS / 60_000 },
      });
      return this.locked();
    }

    return {
      screen: "CODE",
      data: {
        error_message: `${ENROLLMENT_WORDS.wrongCode} ${ENROLLMENT_WORDS.attemptsLeft(CODE_ATTEMPTS - spent)}`,
      },
      terminal: false,
    };
  }

  /** The lockout that is on the number, or nothing. */
  private async lockedOut(channelIdentity: string): Promise<Date | undefined> {
    const { lockedUntil } = await this.enrollments.lockoutFor(channelIdentity);
    return lockedUntil && lockedUntil > this.clock.now() ? lockedUntil : undefined;
  }

  private locked(): EnrollmentScreen {
    return { screen: "LOCKED", data: { message: ENROLLMENT_WORDS.lockedOut }, terminal: true };
  }

  private unavailable(): EnrollmentScreen {
    return {
      screen: "UNAVAILABLE",
      data: { message: ENROLLMENT_WORDS.unavailable },
      terminal: true,
    };
  }

  private async record(
    action:
      | "enrollment.started"
      | "enrollment.account_submitted"
      | "enrollment.code_sent"
      | "enrollment.code_checked"
      | "enrollment.completed",
    outcome: AuditOutcome,
    entry: {
      readonly accountNumber?: string;
      readonly requestId?: string;
      readonly detail?: Readonly<Record<string, unknown>>;
    },
  ): Promise<void> {
    await this.audit.record({
      action,
      actor: { kind: "customer" },
      outcome,
      ...(entry.accountNumber ? { accountNumber: entry.accountNumber } : {}),
      ...(entry.requestId ? { requestId: entry.requestId } : {}),
      ...(entry.detail ? { detail: entry.detail } : {}),
    });
  }
}
