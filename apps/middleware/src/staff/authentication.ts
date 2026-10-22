import { Inject, Injectable } from "@nestjs/common";

import { AuditRepository } from "../audit/audit.repository";
import { hashPassword, needsRehash, verifyPassword } from "./passwords";
import { requiresMfa } from "./roles";
import { StaffRepository, type IssuedSession, type StaffAccount } from "./staff.repository";
import { generateTotpSecret, totpEnrolmentUri, verifyTotp } from "./totp";

/**
 * **The authentication boundary.**
 *
 * Everything above this file deals in a `StaffAccount` and the capabilities its
 * role carries. Nothing above it knows *how* somebody proved who they are.
 *
 * That separation is the seam the Bank's own identity provider will use. An
 * OIDC adapter is another implementation of `authenticate` that resolves a
 * token to an account row; **the roles do not move and no caller changes.**
 * There is one adapter today, so this is a hypothetical seam — but the second
 * one is genuinely expected rather than imagined, and the cost of leaving room
 * for it now is this interface.
 */

/** What a caller offers. A different method would carry different fields. */
export interface PasswordCredentials {
  readonly method: "password";
  readonly email: string;
  readonly password: string;
  /** Absent on the first leg, present once the Customer has been asked. */
  readonly totpCode?: string;
}

export type Credentials = PasswordCredentials;

export type AuthenticationResult =
  | { readonly outcome: "signed_in"; readonly account: StaffAccount; readonly session: IssuedSession }
  /**
   * The password was right and MFA is needed. A distinct outcome rather than a
   * failure, because the Dashboard must ask for a code — and because it is the
   * only place the two are usefully told apart.
   */
  | { readonly outcome: "mfa_required"; readonly enrolled: boolean }
  | { readonly outcome: "refused" };

export interface SignInContext {
  readonly userAgent?: string;
  readonly ipAddress?: string;
  readonly now?: Date;
}

/**
 * A hash of a password nobody has, so a sign-in attempt against an unknown
 * email still pays the full argon2id cost.
 *
 * Without it, an unknown address answers in a millisecond and a real one takes
 * fifty, which enumerates the Bank's staff list from the outside.
 */
let decoyHash: string | undefined;

@Injectable()
export class AuthenticationService {
  public constructor(
    @Inject(StaffRepository) private readonly staff: StaffRepository,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
  ) {}

  public async authenticate(
    credentials: Credentials,
    context: SignInContext = {},
  ): Promise<AuthenticationResult> {
    const now = context.now ?? new Date();
    const found = await this.staff.secretsFor(credentials.email);

    if (!found) {
      // Deliberately still hashing. See `decoyHash`.
      await verifyPassword(await this.decoy(), credentials.password);
      await this.record("refused", { reason: "no such account" });
      return { outcome: "refused" };
    }

    const { account, passwordHash, mfaSecret } = found;

    if (account.disabled) {
      await verifyPassword(passwordHash, credentials.password);
      await this.record("refused", { accountId: account.id, reason: "account disabled" });
      return { outcome: "refused" };
    }

    if (!(await verifyPassword(passwordHash, credentials.password))) {
      await this.record("refused", { accountId: account.id, reason: "wrong password" });
      return { outcome: "refused" };
    }

    // --- The password was right. Now MFA. ------------------------------------

    if (requiresMfa(account.role) && !account.mfaEnrolled) {
      // An Administrator who has not enrolled cannot sign in at all. Letting
      // them through "just this once" is how the requirement becomes optional.
      await this.record("refused", { accountId: account.id, reason: "MFA not enrolled" });
      return { outcome: "mfa_required", enrolled: false };
    }

    if (account.mfaEnrolled) {
      if (credentials.totpCode === undefined) {
        return { outcome: "mfa_required", enrolled: true };
      }
      if (!mfaSecret || !verifyTotp(mfaSecret, credentials.totpCode, now.getTime())) {
        await this.record("refused", { accountId: account.id, reason: "wrong or expired code" });
        return { outcome: "refused" };
      }
    }

    // Raising the argon2id cost later upgrades a hash the next time its owner
    // signs in, rather than needing a migration nobody can run.
    if (needsRehash(passwordHash)) {
      await this.staff.setPassword(account.id, credentials.password);
    }

    const session = await this.staff.issueSession(account.id, {
      ...(context.userAgent === undefined ? {} : { userAgent: context.userAgent }),
      ...(context.ipAddress === undefined ? {} : { ipAddress: context.ipAddress }),
    });

    await this.record("succeeded", {
      accountId: account.id,
      role: account.role,
      method: credentials.method,
    });

    return { outcome: "signed_in", account, session };
  }

  /**
   * Offers a TOTP secret to somebody who has proved the password but is not
   * enrolled.
   *
   * **This is the missing half of ticket 28.** The setup step makes the first
   * Administrator and enrols them at a terminal; everybody after that is invited
   * from the Dashboard, and an Administrator who cannot enrol cannot sign in at
   * all — so without this route, the Officer accounts screen creates
   * Administrators who can never get in. The setup step's own failure message
   * already says *"enrol it from the Dashboard"*; this is that.
   *
   * The password is the whole of the check, and that is correct rather than a
   * compromise: an account with no second factor has exactly one, and somebody
   * holding it can already do everything the account can. What this must never
   * do is let a password alone **replace** a factor that already exists, which
   * is why an enrolled account is refused.
   *
   * The secret is staged on the row rather than handed back and forth, so the
   * code that confirms it is checked against a value the server chose.
   */
  public async beginMfaEnrolment(
    credentials: PasswordCredentials,
    issuer: string,
  ): Promise<{ outcome: "offered"; secret: string; uri: string } | { outcome: "refused" }> {
    const account = await this.proven(credentials);
    if (!account || account.mfaEnrolled) {
      await this.recordEnrolment("staff.mfa_offered", "refused", account, {
        reason: account ? "already enrolled" : "those details were not accepted",
      });
      return { outcome: "refused" };
    }

    const secret = generateTotpSecret();
    if (!(await this.staff.stageMfaSecret(account.id, secret))) {
      // The account grew an enrolment between the read above and this write.
      // The database refuses it rather than this code winning a race.
      await this.recordEnrolment("staff.mfa_offered", "refused", account, {
        reason: "already enrolled",
      });
      return { outcome: "refused" };
    }

    // **Written on the way out, not only on refusal.** A secret has just been
    // handed to a caller who proved a password and nothing else; a row saying so
    // is the whole of the Bank's visibility into that.
    await this.recordEnrolment("staff.mfa_offered", "succeeded", account, { role: account.role });

    return {
      outcome: "offered",
      secret,
      uri: totpEnrolmentUri(secret, account.email, issuer),
    };
  }

  /** Finishes it, against the staged secret and a code out of the authenticator. */
  public async completeMfaEnrolment(
    credentials: PasswordCredentials,
    code: string,
    now: Date = new Date(),
  ): Promise<{ outcome: "enrolled" } | { outcome: "refused" }> {
    const account = await this.proven(credentials);
    const found = account ? await this.staff.secretsFor(account.email) : undefined;
    const pending = found?.pendingMfaSecret;

    if (!account || account.mfaEnrolled || !pending) {
      await this.recordEnrolment("staff.mfa_enrolled", "refused", account, {
        reason: account ? "nothing offered to confirm" : "those details were not accepted",
      });
      return { outcome: "refused" };
    }

    if (!verifyTotp(pending, code, now.getTime())) {
      await this.recordEnrolment("staff.mfa_enrolled", "refused", account, {
        reason: "wrong or expired code",
      });
      return { outcome: "refused" };
    }

    if (!(await this.staff.confirmMfa(account.id))) {
      await this.recordEnrolment("staff.mfa_enrolled", "refused", account, {
        reason: "already enrolled",
      });
      return { outcome: "refused" };
    }

    await this.recordEnrolment("staff.mfa_enrolled", "succeeded", account, { role: account.role });
    return { outcome: "enrolled" };
  }

  /**
   * The account behind an email and password, or nothing — **paying the full
   * argon2id cost either way**.
   *
   * The same decoy the sign-in path uses. Without it these routes answer an
   * unknown address in a millisecond and a real one in fifty, which enumerates
   * the Bank's staff list from outside just as well as the sign-in form would
   * have.
   */
  private async proven(credentials: PasswordCredentials): Promise<StaffAccount | undefined> {
    const found = await this.staff.secretsFor(credentials.email);
    if (!found) {
      await verifyPassword(await this.decoy(), credentials.password);
      return undefined;
    }

    const right = await verifyPassword(found.passwordHash, credentials.password);
    if (!right || found.account.disabled) return undefined;
    return found.account;
  }

  private async recordEnrolment(
    action: "staff.mfa_offered" | "staff.mfa_enrolled",
    outcome: "succeeded" | "refused",
    account: StaffAccount | undefined,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      action,
      actor: account ? { kind: "officer", id: account.id } : { kind: "system" },
      outcome,
      detail,
    });
  }

  /** Resolves the token the Dashboard holds, on every request. */
  public async accountForToken(
    token: string | undefined,
  ): Promise<{ account: StaffAccount; sessionId: string } | undefined> {
    return this.staff.accountForToken(token);
  }

  public async signOut(sessionId: string, accountId: string): Promise<void> {
    await this.staff.revokeSession(sessionId);
    await this.audit.record({
      action: "staff.signed_out",
      actor: { kind: "officer", id: accountId },
      outcome: "succeeded",
    });
  }

  private async record(
    outcome: "succeeded" | "refused",
    detail: Record<string, unknown> & { accountId?: string },
  ): Promise<void> {
    const { accountId, ...rest } = detail;
    await this.audit.record({
      action: "staff.sign_in",
      // An unknown email has nobody to attribute the attempt to.
      actor: accountId ? { kind: "officer", id: accountId } : { kind: "system" },
      outcome,
      detail: rest,
    });
  }

  private async decoy(): Promise<string> {
    decoyHash ??= await hashPassword("a password nobody holds");
    return decoyHash;
  }
}
