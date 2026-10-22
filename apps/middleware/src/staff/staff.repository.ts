import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import type { Pool } from "@avni/db";
import { DATABASE_POOL } from "@avni/service";

import { hashPassword } from "./passwords";
import type { Role } from "./roles";

/**
 * A member of the Bank's staff, as everything above this file sees them.
 *
 * **No password hash and no MFA secret.** Those never leave this module: a
 * shape that carries them is a shape somebody eventually logs.
 */
export interface StaffAccount {
  readonly id: string;
  readonly email: string;
  /** Shown to a Customer when an Officer takes over a conversation. */
  readonly displayName: string;
  readonly role: Role;
  readonly mfaEnrolled: boolean;
  readonly disabled: boolean;
}

export interface StaffSession {
  readonly id: string;
  readonly accountId: string;
  readonly expiresAt: Date;
}

/**
 * One session an account is holding, as an Administrator is shown it.
 *
 * **Never the token, and never its hash.** What is here is enough to recognise a
 * session — when it started, when it was last used, and from what — and nothing
 * that could be used to become it.
 */
export interface LiveSession {
  readonly id: string;
  readonly startedAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
  readonly userAgent: string | null;
  readonly ipAddress: string | null;
}

interface AccountRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  role: Role;
  mfa_secret: string | null;
  mfa_enrolled_at: Date | null;
  /** Offered, not yet proved. See migration 0010 for why it is a second column. */
  mfa_pending_secret: string | null;
  disabled_at: Date | null;
}

interface SessionRow {
  id: string;
  staff_account_id: string;
  expires_at: Date;
  revoked_at: Date | null;
}

const ACCOUNT_COLUMNS =
  "id, email, display_name, password_hash, role, mfa_secret, mfa_enrolled_at, mfa_pending_secret, disabled_at";

const toAccount = (row: AccountRow): StaffAccount => ({
  id: row.id,
  email: row.email,
  displayName: row.display_name,
  role: row.role,
  mfaEnrolled: row.mfa_enrolled_at !== null,
  disabled: row.disabled_at !== null,
});

/**
 * Sessions are **eight hours**, which is a shift.
 *
 * Not the prior art's seven days, and not "until you sign out": the Dashboard
 * reaches every Customer's balance and history, and a laptop left open in a
 * branch is the ordinary case rather than the exotic one.
 */
export const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;

/** The token the Dashboard holds, and the hash that is all we store. */
export interface IssuedSession {
  readonly token: string;
  readonly session: StaffSession;
}

const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

@Injectable()
export class StaffRepository {
  public constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  // --- Accounts -------------------------------------------------------------

  public async countAccounts(): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      "select count(*)::text as count from staff_accounts",
    );
    return Number(rows[0]?.count ?? 0);
  }

  public async findByEmail(email: string): Promise<StaffAccount | undefined> {
    const row = await this.rowByEmail(email);
    return row ? toAccount(row) : undefined;
  }

  public async findById(id: string): Promise<StaffAccount | undefined> {
    if (!UUID.test(id)) return undefined;
    const { rows } = await this.pool.query<AccountRow>(
      `select ${ACCOUNT_COLUMNS} from staff_accounts where id = $1`,
      [id],
    );
    return rows[0] ? toAccount(rows[0]) : undefined;
  }

  public async createAccount(input: {
    email: string;
    displayName: string;
    password: string;
    role: Role;
  }): Promise<StaffAccount> {
    const { rows } = await this.pool.query<AccountRow>(
      `insert into staff_accounts (email, display_name, password_hash, role)
       values ($1, $2, $3, $4)
       returning ${ACCOUNT_COLUMNS}`,
      [input.email.trim(), input.displayName.trim(), await hashPassword(input.password), input.role],
    );
    return toAccount(rows[0] as AccountRow);
  }

  /**
   * The stored hash and MFA secret, for the authenticator alone.
   *
   * Deliberately a separate call from `findByEmail`, so that reaching a secret
   * is a thing somebody had to ask for rather than a field that came along for
   * the ride.
   */
  public async secretsFor(email: string): Promise<
    | {
        account: StaffAccount;
        passwordHash: string;
        mfaSecret: string | null;
        /** Offered and not yet confirmed. Never accepted as a factor. */
        pendingMfaSecret: string | null;
      }
    | undefined
  > {
    const row = await this.rowByEmail(email);
    return row
      ? {
          account: toAccount(row),
          passwordHash: row.password_hash,
          mfaSecret: row.mfa_secret,
          pendingMfaSecret: row.mfa_pending_secret,
        }
      : undefined;
  }

  public async setPassword(accountId: string, password: string): Promise<void> {
    await this.pool.query(
      "update staff_accounts set password_hash = $2, updated_at = now() where id = $1",
      [accountId, await hashPassword(password)],
    );
  }

  public async enrolMfa(accountId: string, secret: string): Promise<void> {
    await this.pool.query(
      `update staff_accounts
         set mfa_secret = $2, mfa_enrolled_at = now(), mfa_pending_secret = null,
             updated_at = now()
       where id = $1`,
      [accountId, secret],
    );
  }

  /**
   * Offers a secret **without enrolling it**, in a column of its own.
   *
   * Not `mfa_secret`: migration 0003 constrains that and `mfa_enrolled_at` to be
   * null or set together, which is what makes *"MFA is required"* a fact about
   * the schema. A secret somebody has been shown and not yet proved they can
   * read is a different thing, so it gets a different column — and until they
   * prove it, `mfaEnrolled` is still false and an Administrator still cannot
   * sign in.
   *
   * The `where` clause is the other half of migration 0010's check: a pending
   * secret is never written over an existing enrolment, so a leaked password
   * cannot swap somebody's authenticator out from under them.
   */
  public async stageMfaSecret(accountId: string, secret: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `update staff_accounts set mfa_pending_secret = $2, updated_at = now()
        where id = $1 and mfa_enrolled_at is null`,
      [accountId, secret],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Promotes the offered secret to the enrolled one, in one statement. */
  public async confirmMfa(accountId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `update staff_accounts
          set mfa_secret = mfa_pending_secret,
              mfa_enrolled_at = now(),
              mfa_pending_secret = null,
              updated_at = now()
        where id = $1 and mfa_enrolled_at is null and mfa_pending_secret is not null`,
      [accountId],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Changes what an Administrator may change about somebody else's account.
   *
   * Deliberately not a general update: the password has its own call because it
   * has to be hashed, and `email` is absent because an account's address is what
   * signs it in and what its audit rows were written against. Somebody who needs
   * a different address needs a different account.
   */
  public async updateAccount(
    accountId: string,
    changes: { displayName?: string; role?: Role; disabled?: boolean },
  ): Promise<StaffAccount | undefined> {
    // An id that is not a uuid is *no such account*, not a `500`. It reaches
    // here off a URL, and Postgres would throw on the cast.
    if (!UUID.test(accountId)) return undefined;

    const { rows } = await this.pool.query<AccountRow>(
      `update staff_accounts
          set display_name = coalesce($2, display_name),
              role         = coalesce($3, role),
              disabled_at  = case
                               when $4::boolean is null then disabled_at
                               when $4::boolean then coalesce(disabled_at, now())
                               else null
                             end,
              updated_at   = now()
        where id = $1
        returning ${ACCOUNT_COLUMNS}`,
      [
        accountId,
        changes.displayName ?? null,
        changes.role ?? null,
        changes.disabled ?? null,
      ],
    );

    const row = rows[0];
    if (!row) return undefined;

    // A disabled account keeps no live session. Leaving one would make
    // *"their access is off"* true of the sign-in page and false of every page
    // behind it until the eight hours ran out.
    if (changes.disabled === true) await this.revokeAllSessions(accountId);

    return toAccount(row);
  }

  /**
   * How many Administrators **could sign in right now** — which is not the same
   * as how many exist.
   *
   * Enabled *and* enrolled in MFA, because an Administrator who has not enrolled
   * cannot sign in at all. Counting them would let the last usable Administrator
   * be demoted on the strength of an account nobody can get into, which is the
   * exact outcome this count exists to prevent.
   *
   * Load-bearing rather than informational. The setup step **declines if any
   * account exists**, so a deployment that loses its last Administrator has no
   * route back except somebody with database access — which is exactly the
   * position the Bank pays a vendor not to be in.
   */
  public async liveAdministrators(): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `select count(*)::text as count from staff_accounts
        where role = 'administrator'
          and disabled_at is null
          and mfa_enrolled_at is not null`,
    );
    return Number(rows[0]?.count ?? 0);
  }

  public async setDisabled(accountId: string, disabled: boolean): Promise<void> {
    await this.pool.query(
      `update staff_accounts set disabled_at = $2, updated_at = now() where id = $1`,
      [accountId, disabled ? new Date() : null],
    );
    if (disabled) await this.revokeAllSessions(accountId);
  }

  public async listAccounts(): Promise<readonly StaffAccount[]> {
    const { rows } = await this.pool.query<AccountRow>(
      `select ${ACCOUNT_COLUMNS} from staff_accounts order by lower(email)`,
    );
    return rows.map(toAccount);
  }

  // --- Sessions -------------------------------------------------------------

  /**
   * Issues a session and returns the token **once**. Only its hash is stored,
   * so a database dump is not a set of live logins.
   */
  public async issueSession(
    accountId: string,
    context: { userAgent?: string; ipAddress?: string } = {},
  ): Promise<IssuedSession> {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);

    const { rows } = await this.pool.query<SessionRow>(
      `insert into staff_sessions (token_hash, staff_account_id, expires_at, user_agent, ip_address)
       values ($1, $2, $3, $4, $5)
       returning id, staff_account_id, expires_at, revoked_at`,
      [hashToken(token), accountId, expiresAt, context.userAgent ?? null, context.ipAddress ?? null],
    );
    const row = rows[0] as SessionRow;

    return {
      token,
      session: { id: row.id, accountId: row.staff_account_id, expiresAt: row.expires_at },
    };
  }

  /**
   * The account a token belongs to, if the session is live.
   *
   * Checked **server-side on every request**. That is what makes a session
   * revocable without a redeploy — the prior art's in-memory sessions could not
   * be killed at all, and a restart signed everybody out instead.
   */
  public async accountForToken(
    token: string | undefined,
    now: Date = new Date(),
  ): Promise<{ account: StaffAccount; sessionId: string } | undefined> {
    if (!token) return undefined;

    const { rows } = await this.pool.query<AccountRow & SessionRow & { session_id: string }>(
      `select s.id as session_id, s.staff_account_id, s.expires_at, s.revoked_at,
              a.id, a.email, a.display_name, a.password_hash, a.role,
              a.mfa_secret, a.mfa_enrolled_at, a.disabled_at
         from staff_sessions s
         join staff_accounts a on a.id = s.staff_account_id
        where s.token_hash = $1`,
      [hashToken(token)],
    );

    const row = rows[0];
    if (!row) return undefined;
    if (row.revoked_at !== null) return undefined;
    if (row.expires_at.getTime() <= now.getTime()) return undefined;
    if (row.disabled_at !== null) return undefined;

    await this.pool.query("update staff_sessions set last_seen_at = now() where id = $1", [
      row.session_id,
    ]);

    return { account: toAccount(row), sessionId: row.session_id };
  }

  /**
   * The sessions one account is holding right now.
   *
   * The columns were put on the table by ticket 28 *"so a Support Officer can be
   * shown where their sessions are and kill one they do not recognise"*, and
   * nothing read them until this. Without it, *"sign out everywhere"* is a
   * button an Administrator presses without knowing whether there was anything
   * to sign out — which is exactly the state a report of a stolen laptop starts
   * from.
   *
   * **No token and no hash**, here or anywhere above. A session is named by an
   * id that cannot be used to become it.
   */
  public async liveSessionsFor(accountId: string): Promise<readonly LiveSession[]> {
    if (!UUID.test(accountId)) return [];

    const { rows } = await this.pool.query<{
      id: string;
      created_at: Date;
      last_seen_at: Date;
      expires_at: Date;
      user_agent: string | null;
      ip_address: string | null;
    }>(
      `select id, created_at, last_seen_at, expires_at, user_agent, ip_address
         from staff_sessions
        where staff_account_id = $1 and revoked_at is null and expires_at > now()
        order by last_seen_at desc`,
      [accountId],
    );

    return rows.map((row) => ({
      id: row.id,
      startedAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
      userAgent: row.user_agent,
      ipAddress: row.ip_address,
    }));
  }

  public async revokeSession(sessionId: string): Promise<void> {
    if (!UUID.test(sessionId)) return;
    await this.pool.query(
      "update staff_sessions set revoked_at = now() where id = $1 and revoked_at is null",
      [sessionId],
    );
  }

  /** Every session this person holds — for a stolen laptop, or a leaver. */
  public async revokeAllSessions(accountId: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      "update staff_sessions set revoked_at = now() where staff_account_id = $1 and revoked_at is null",
      [accountId],
    );
    return rowCount ?? 0;
  }

  private async rowByEmail(email: string): Promise<AccountRow | undefined> {
    const { rows } = await this.pool.query<AccountRow>(
      `select ${ACCOUNT_COLUMNS} from staff_accounts where lower(email) = lower($1)`,
      [email.trim()],
    );
    return rows[0];
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Exported for the authenticator's constant-time comparisons. */
export const constantTimeEquals = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
};
