import { createHash, randomBytes } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import type { Pool } from "@avni/db";
import { CLOCK, DATABASE_POOL, type Clock } from "@avni/service";

/**
 * A sealed surface that has been opened and has **no destination yet**.
 *
 * Every other transfer in this codebase reaches the handset already resolved:
 * the Customer said an account number, the Middleware turned it into a Mandate,
 * and the token names that Mandate. A transfer by *name* cannot do that when
 * several saved recipients answer to the name, or none do — so the token names
 * this instead, and the Mandate is written underneath it once the Customer has
 * chosen.
 *
 * **The amount is here rather than in the payload**, for the same reason it is
 * on the Mandate: a Flow encrypts with a key the handset generates, so the
 * handset owns that plaintext entirely, and a value the server rendered must
 * never come back through it. What the payload may carry is what the Customer
 * newly supplies — the row they tapped, an account number they typed, a label.
 */

export type WalkPurpose = "transfer" | "forget";

export interface TransferWalk {
  readonly id: string;
  readonly conversationId: string;
  /** From the Binding. Also the key the Beneficiary store is read under. */
  readonly sourceAccount: string;
  /**
   * What the Customer called somebody, kept so a `BACK` re-renders the list the
   * Customer was already reading rather than a different one.
   *
   * It is a string a model extracted from a Customer's message, and it is used
   * as a search key and **never rendered back** — a screen that quoted it would
   * be this platform repeating an injection surface to the person it is
   * protecting.
   */
  readonly saidName: string;
  readonly purpose: WalkPurpose;
  /** Naira. Null on a `forget` walk, which has no amount to carry. */
  readonly amount: number | null;
  /** The proposal this walk resolved to, once it has one. */
  readonly mandateId: string | null;
  readonly createdAt: Date;
}

export interface NewWalk {
  readonly conversationId: string;
  readonly sourceAccount: string;
  readonly saidName: string;
  readonly purpose: WalkPurpose;
  readonly amount?: number | undefined;
}

interface WalkRow {
  id: string;
  conversation_id: string;
  source_account: string;
  said_name: string;
  purpose: WalkPurpose;
  /** `numeric` arrives as a string, which is exactly the point of `numeric`. */
  amount: string | null;
  mandate_id: string | null;
  created_at: Date;
}

const COLUMNS =
  "id, conversation_id, source_account, said_name, purpose, amount, mandate_id, created_at";

const toWalk = (row: WalkRow): TransferWalk => ({
  id: row.id,
  conversationId: row.conversation_id,
  sourceAccount: row.source_account,
  saidName: row.said_name,
  purpose: row.purpose,
  amount: row.amount === null ? null : Number(row.amount),
  mandateId: row.mandate_id,
  createdAt: row.created_at,
});

/** The Flow token is a bearer credential, so only its hash is stored. */
const hashToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

@Injectable()
export class WalksRepository {
  public constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Opens a walk and mints the token that names it.
   *
   * The token is the only thing that comes back. It is handed to the handset
   * inside the sealed surface, and is never stored and never logged.
   */
  public async start(walk: NewWalk): Promise<string> {
    const token = randomBytes(32).toString("base64url");

    await this.pool.query(
      `insert into transfer_walks
         (token_hash, conversation_id, source_account, said_name, purpose, amount, created_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        hashToken(token),
        walk.conversationId,
        walk.sourceAccount,
        walk.saidName,
        walk.purpose,
        walk.amount ?? null,
        this.clock.now(),
      ],
    );

    return token;
  }

  public async findByToken(token: string | undefined): Promise<TransferWalk | undefined> {
    if (!token) return undefined;

    const { rows } = await this.pool.query<WalkRow>(
      `select ${COLUMNS} from transfer_walks where token_hash = $1`,
      [hashToken(token)],
    );
    return rows[0] ? toWalk(rows[0]) : undefined;
  }

  /**
   * Points the walk at the proposal it just resolved to.
   *
   * A walk may resolve more than once — a Customer who goes back a screen and
   * taps somebody else — and the proposal it leaves behind is unauthorised by
   * construction, because authorising one is what ends the walk. Nothing needs
   * cleaning up: the older proposal expires with every other unauthorised one,
   * and it is unreachable in the meantime because nothing names it.
   */
  public async resolvedTo(id: string, mandateId: string): Promise<void> {
    await this.pool.query("update transfer_walks set mandate_id = $2 where id = $1", [
      id,
      mandateId,
    ]);
  }
}
