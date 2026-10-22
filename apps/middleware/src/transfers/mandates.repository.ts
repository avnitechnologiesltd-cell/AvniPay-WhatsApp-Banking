import { createHash, randomBytes } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import type { Pool } from "@avni/db";
import { CLOCK, DATABASE_POOL, type Clock } from "@avni/service";

import { mintReference } from "./reference";

/**
 * Where the **Mandate** lives.
 *
 * An Intent says what the Customer asked for; a Mandate says what the Bank will
 * do, and **every field of it is written here** ([ADR-0008](../../../../docs/adr/0008-an-intent-becomes-a-mandate-when-authorised.md)).
 * That is what makes a tampered payload inert: the sealed surface carries a
 * token, the token names a row, and every value the transfer uses is read back
 * from that row rather than from anything the handset sent.
 *
 * Two of the methods below claim a column rather than reading it and writing it
 * after, and both are money-correctness rules rather than tidiness:
 *
 * - **`authorise` is single-use.** Two taps on the same PIN screen race, and the
 *   loser of that race must not become a second debit.
 * - **`claimDispatch` is once per Mandate.** A dispatch whose response never
 *   arrived may still have moved money, so the second attempt asks the status
 *   query about the reference rather than sending the transfer again.
 */

export type MandateOutcome = "succeeded" | "failed" | "pending";

/**
 * A transfer the Middleware has resolved and is showing the Customer. **Not yet
 * a Mandate**, because nobody has authorised it.
 *
 * It is stored before the PIN because it has to be: the sealed surface carries a
 * token, the token names this row, and every value the Confirmation screen shows
 * is read back from it. That is what makes a tampered payload inert.
 *
 * What it is *not* is something that can reach BankOne — see `Mandate` below.
 */
export interface ProposedTransfer {
  readonly id: string;
  readonly conversationId: string;
  /** From the Binding. The Intent names no account and the Platform holds none. */
  readonly sourceAccount: string;
  readonly destinationAccount: string;
  /**
   * The destination bank's NIBSS code, and **the only thing that decides which
   * endpoint moves this money**. Equal to the Bank's own code is intra-bank;
   * anything else is inter-bank, at dispatch as much as at proposal.
   */
  readonly destinationBankCode: string;
  readonly destinationBank: string;
  /** From name enquiry, never from a saved label. */
  readonly destinationName: string;
  /** The recipient's KYC tier, where their own bank reported one. */
  readonly destinationKyc: string | null;
  /**
   * The sending account's name, as this Bank reports it. `null` on an intra-bank
   * transfer, which does not send one and does not pay to fetch one.
   */
  readonly payerName: string | null;
  /**
   * The saved recipient this transfer was resolved from, where it was resolved
   * from one at all. Null on a transfer to a typed account number.
   */
  readonly beneficiaryId: string | null;
  /**
   * The bank's name for this account **on the day it was saved**, copied here so
   * the comparison is made against the value the Customer approved rather than
   * against a record that may have moved since.
   *
   * When it differs from `destinationName`, both are said before the PIN. A
   * changed name is the clearest available signal that an account has changed
   * hands, and it is free on every transfer.
   */
  readonly savedName: string | null;
  /** Naira. Never kobo. */
  readonly amount: number;
  /** Minted here, ≤12 characters, reused verbatim for the status query. */
  readonly reference: string;
  readonly createdAt: Date;
  readonly authorisedAt: Date | null;
  readonly dispatchedAt: Date | null;
  readonly outcome: MandateOutcome | null;
}

/**
 * A **Mandate**: an instruction the Customer has authorised, and the only thing
 * the Banking Layer will execute ([ADR-0008](../../../../docs/adr/0008-an-intent-becomes-a-mandate-when-authorised.md)).
 *
 * One field's type is the whole point. `authorisedAt` is a `Date` here and
 * `Date | null` on a `ProposedTransfer`, so **only `authorise` can produce
 * one** — it is the sole place the narrowing happens, and it does so by winning
 * a race in the database rather than by checking a flag.
 *
 * ADR-0008 rejected one type with a status field, and this is why: the function
 * that dispatches to BankOne takes a `Mandate`, so an unauthorised transfer is
 * not something a caller can pass it. The mistake stops being a code-review
 * problem and becomes impossible to express. The schema's
 * `mandates_dispatch_follows_authorisation` says the same thing where a future
 * caller cannot argue with it, and neither is load-bearing alone.
 *
 * CONTEXT.md is strict about the word and so is this type: a Mandate is what a
 * Customer authorised. What they are *looking at* is a `ProposedTransfer`.
 */
export interface Mandate extends ProposedTransfer {
  readonly authorisedAt: Date;
}

/** Everything the Middleware resolved before it asked the Customer to confirm. */
export interface NewTransfer {
  readonly conversationId: string;
  readonly sourceAccount: string;
  readonly destinationAccount: string;
  readonly destinationBankCode: string;
  readonly destinationBank: string;
  readonly destinationName: string;
  readonly destinationKyc?: string | undefined;
  readonly payerName?: string | undefined;
  readonly beneficiaryId?: string | undefined;
  readonly savedName?: string | undefined;
  readonly amount: number;
}

export interface CreatedTransfer {
  /** Handed to the handset inside the sealed surface. Never stored, never logged. */
  readonly token: string;
  readonly proposed: ProposedTransfer;
}

interface MandateRow {
  id: string;
  conversation_id: string;
  source_account: string;
  destination_account: string;
  destination_bank_code: string;
  destination_bank: string;
  destination_name: string;
  destination_kyc: string | null;
  payer_name: string | null;
  beneficiary_id: string | null;
  saved_name: string | null;
  /** `numeric` arrives as a string, which is exactly the point of `numeric`. */
  amount: string;
  reference: string;
  created_at: Date;
  authorised_at: Date | null;
  dispatched_at: Date | null;
  outcome: MandateOutcome | null;
}

const COLUMNS = `id, conversation_id, source_account, destination_account, destination_bank_code,
                 destination_bank, destination_name, destination_kyc, payer_name,
                 beneficiary_id, saved_name, amount,
                 reference, created_at, authorised_at, dispatched_at, outcome`;

const toProposed = (row: MandateRow): ProposedTransfer => ({
  id: row.id,
  conversationId: row.conversation_id,
  sourceAccount: row.source_account,
  destinationAccount: row.destination_account,
  destinationBankCode: row.destination_bank_code,
  destinationBank: row.destination_bank,
  destinationName: row.destination_name,
  destinationKyc: row.destination_kyc,
  payerName: row.payer_name,
  beneficiaryId: row.beneficiary_id,
  savedName: row.saved_name,
  amount: Number(row.amount),
  reference: row.reference,
  createdAt: row.created_at,
  authorisedAt: row.authorised_at,
  dispatchedAt: row.dispatched_at,
  outcome: row.outcome,
});

/** The Flow token is a bearer credential, so only its hash is stored. */
const hashToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

/** Postgres's unique violation. The reference index is the one that raises it. */
const UNIQUE_VIOLATION = "23505";

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: string }).code === UNIQUE_VIOLATION;

@Injectable()
export class MandatesRepository {
  public constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Writes the proposed transfer and mints the token that names it.
   *
   * The reference is minted here and the unique index decides whether it stood.
   * Sixty bits make a collision vanishingly unlikely and the retry is what makes
   * "unlikely" unnecessary to reason about — a duplicate reference is a debit
   * that could happen twice, and BankOne guarantees no idempotency of its own.
   */
  public async create(transfer: NewTransfer): Promise<CreatedTransfer> {
    const token = randomBytes(32).toString("base64url");

    for (let attempt = 0; ; attempt += 1) {
      try {
        const { rows } = await this.pool.query<MandateRow>(
          `insert into mandates
             (token_hash, conversation_id, source_account, destination_account,
              destination_bank_code, destination_bank, destination_name, destination_kyc,
              payer_name, beneficiary_id, saved_name, amount, reference, created_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           returning ${COLUMNS}`,
          [
            hashToken(token),
            transfer.conversationId,
            transfer.sourceAccount,
            transfer.destinationAccount,
            transfer.destinationBankCode,
            transfer.destinationBank,
            transfer.destinationName,
            transfer.destinationKyc ?? null,
            transfer.payerName ?? null,
            transfer.beneficiaryId ?? null,
            transfer.savedName ?? null,
            transfer.amount,
            mintReference(),
            this.clock.now(),
          ],
        );
        return { token, proposed: toProposed(rows[0] as MandateRow) };
      } catch (error) {
        if (!isUniqueViolation(error) || attempt >= 2) throw error;
      }
    }
  }

  public async findByToken(token: string | undefined): Promise<ProposedTransfer | undefined> {
    if (!token) return undefined;

    const { rows } = await this.pool.query<MandateRow>(
      `select ${COLUMNS} from mandates where token_hash = $1`,
      [hashToken(token)],
    );
    return rows[0] ? toProposed(rows[0]) : undefined;
  }

  /**
   * The proposal a **walk** resolved to.
   *
   * Reached by id rather than by token, because a walk that began before there
   * was any destination is what the handset's token names. The id itself comes
   * off that walk's own row and never out of a payload.
   */
  public async findById(id: string): Promise<ProposedTransfer | undefined> {
    const { rows } = await this.pool.query<MandateRow>(
      `select ${COLUMNS} from mandates where id = $1`,
      [id],
    );
    return rows[0] ? toProposed(rows[0]) : undefined;
  }

  /**
   * **The only place a `Mandate` comes into existence.**
   *
   * One statement, so the check and the write cannot be separated by anything —
   * two taps on the same PIN screen race here, and the loser gets `undefined`
   * rather than a second debit. The row it returns has `authorised_at` set, so
   * the narrowing to `Mandate` is a fact the database established rather than a
   * cast this code performed.
   */
  public async authorise(id: string): Promise<Mandate | undefined> {
    const { rows } = await this.pool.query<MandateRow>(
      `update mandates set authorised_at = $2
       where id = $1 and authorised_at is null
       returning ${COLUMNS}`,
      [id, this.clock.now()],
    );
    const row = rows[0];
    if (!row?.authorised_at) return undefined;

    return { ...toProposed(row), authorisedAt: row.authorised_at };
  }

  /** Claims the one dispatch this Mandate gets. `false` means it already had it. */
  public async claimDispatch(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "update mandates set dispatched_at = $2 where id = $1 and dispatched_at is null",
      [id, this.clock.now()],
    );
    return (rowCount ?? 0) > 0;
  }

  /** What BankOne finally said. `pending` is an answer, not an absence of one. */
  public async settle(id: string, outcome: MandateOutcome): Promise<void> {
    await this.pool.query(
      "update mandates set outcome = $2, settled_at = $3 where id = $1",
      [id, outcome, this.clock.now()],
    );
  }
}
