import { Inject, Injectable } from "@nestjs/common";

import type { Pool } from "@avni/db";
import { CLOCK, DATABASE_POOL, type Clock } from "@avni/service";

import { tidy } from "./matching";

/**
 * Where a Customer's saved recipients live, and the only thing that reads them.
 *
 * **The Orchestration Layer never sees this file's output.** It emits the string
 * `"Musa"` and the Middleware turns it into an account
 * ([ADR-0008](../../../../docs/adr/0008-an-intent-becomes-a-mandate-when-authorised.md));
 * a list of everybody a Customer pays is precisely the sort of thing ADR-0006
 * keeps out of the layer that reads Customer text into a model.
 *
 * Two rules are worth reading before the SQL below:
 *
 * **A record is created only by a PIN-authorised transfer.** There is no
 * save-without-paying, so planting one costs an attacker a completed, authorised
 * transfer rather than a single injected instruction.
 *
 * **Every method that takes an id also takes the `ownerAccount`.** Not by
 * convention — it is in the signature, so there is no call shape that reaches
 * another Customer's records with an id. That is what makes it safe for the
 * Disambiguation screen to send back a record the Customer tapped.
 *
 * `forgetCreatedBy` is the one method with no owner argument, and it does not
 * need one: it is named by a **Mandate**, a Mandate belongs to exactly one
 * source account, and the row it deletes is the row that Mandate wrote. Nothing
 * a handset sends reaches it.
 */

export interface Beneficiary {
  readonly id: string;
  /** The Customer's account. **Not the Binding**, which a phone change destroys. */
  readonly ownerAccount: string;
  readonly accountNumber: string;
  readonly bankCode: string;
  readonly bankName: string;
  /** The bank's own name for the account on the day it was saved. */
  readonly nameAtSave: string;
  /** The Customer's own word, or empty. Never proof of who holds the account. */
  readonly label: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date;
  /** The authorised transfer that brought this row into existence, if it stands. */
  readonly createdByMandateId: string | null;
}

/** What a completed transfer knows about the recipient it just paid. */
export interface NewBeneficiary {
  readonly ownerAccount: string;
  readonly accountNumber: string;
  readonly bankCode: string;
  readonly bankName: string;
  /** From name enquiry. The saved name is the bank's, never the Customer's. */
  readonly nameAtSave: string;
  /** What the Customer typed into "Save as", or empty. */
  readonly label: string;
  /** The Mandate this record is a by-product of. */
  readonly mandateId: string;
}

interface BeneficiaryRow {
  id: string;
  owner_account: string;
  account_number: string;
  bank_code: string;
  bank_name: string;
  name_at_save: string;
  label: string;
  created_at: Date;
  last_used_at: Date;
  created_by_mandate_id: string | null;
}

const COLUMNS = `id, owner_account, account_number, bank_code, bank_name, name_at_save,
                 label, created_at, last_used_at, created_by_mandate_id`;

const toBeneficiary = (row: BeneficiaryRow): Beneficiary => ({
  id: row.id,
  ownerAccount: row.owner_account,
  accountNumber: row.account_number,
  bankCode: row.bank_code,
  bankName: row.bank_name,
  nameAtSave: row.name_at_save,
  label: row.label,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  createdByMandateId: row.created_by_mandate_id,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class BeneficiariesRepository {
  public constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * One Customer's whole store, most-recently-used first.
   *
   * The whole of it, because the matching rule is normalisation this codebase
   * states once in `matching.ts` — asking Postgres to reproduce it in a `where`
   * clause would be a second implementation, kept in step by nothing, of the one
   * rule that decides who gets paid. A store is tens of rows.
   */
  public async findAllFor(ownerAccount: string): Promise<readonly Beneficiary[]> {
    const { rows } = await this.pool.query<BeneficiaryRow>(
      `select ${COLUMNS} from beneficiaries
       where owner_account = $1
       order by last_used_at desc`,
      [ownerAccount],
    );
    return rows.map(toBeneficiary);
  }

  /**
   * One record, **only if this Customer owns it**.
   *
   * The id comes back from the handset as a tapped row, so this is the check
   * that makes that safe. A malformed id is a miss rather than a crash, the same
   * way a made-up conversation id is.
   */
  public async findOwned(
    id: string,
    ownerAccount: string,
  ): Promise<Beneficiary | undefined> {
    if (!UUID.test(id)) return undefined;

    const { rows } = await this.pool.query<BeneficiaryRow>(
      `select ${COLUMNS} from beneficiaries where id = $1 and owner_account = $2`,
      [id, ownerAccount],
    );
    return rows[0] ? toBeneficiary(rows[0]) : undefined;
  }

  /**
   * Saves the recipient a Customer has just authorised paying, or notes that
   * they paid somebody already saved.
   *
   * **`name_at_save` is written once and never refreshed**, which is the whole
   * of what makes the changed-name warning work. Refreshing it on every transfer
   * would consume the signal at the first approval: a Customer who tapped
   * through *"this account is now CHIDI EZE"* once would never be told again,
   * about an account that had already changed hands. Being told every time is
   * noise; being told once is the free signal thrown away.
   *
   * The **label** is different, and updates: a Customer who types a new "Save
   * as" for somebody they have paid before means to rename them. An empty one
   * means they left the field alone, and leaves the existing label standing.
   */
  public async save(beneficiary: NewBeneficiary): Promise<Beneficiary> {
    const now = this.clock.now();
    const { rows } = await this.pool.query<BeneficiaryRow>(
      `insert into beneficiaries
         (owner_account, account_number, bank_code, bank_name, name_at_save, label,
          created_by_mandate_id, created_at, last_used_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       on conflict (owner_account, bank_code, account_number) do update
         set last_used_at = excluded.last_used_at,
             label = case when excluded.label = '' then beneficiaries.label else excluded.label end
       returning ${COLUMNS}`,
      [
        beneficiary.ownerAccount,
        beneficiary.accountNumber,
        beneficiary.bankCode,
        beneficiary.bankName,
        beneficiary.nameAtSave,
        // Tidied on the way in, with the same function resolution normalises
        // by. A label stored under one set of rules and searched under another
        // is a label that cannot be found.
        tidy(beneficiary.label),
        beneficiary.mandateId,
        now,
      ],
    );
    return toBeneficiary(rows[0] as BeneficiaryRow);
  }

  /** Removes a record the Customer tapped. `undefined` means it was not theirs. */
  public async forget(id: string, ownerAccount: string): Promise<Beneficiary | undefined> {
    if (!UUID.test(id)) return undefined;

    const { rows } = await this.pool.query<BeneficiaryRow>(
      `delete from beneficiaries where id = $1 and owner_account = $2 returning ${COLUMNS}`,
      [id, ownerAccount],
    );
    return rows[0] ? toBeneficiary(rows[0]) : undefined;
  }

  /**
   * Undoes the save a transfer made, once that transfer is confirmed failed.
   *
   * **Only the record it created.** A second payment to somebody already saved
   * touches their `last_used_at` and nothing else, so a failure there must leave
   * the record standing — it was not this transfer's to remove. The column says
   * which, so this is a `delete ... where` rather than a flag somebody has to
   * remember to set.
   */
  public async forgetCreatedBy(mandateId: string): Promise<Beneficiary | undefined> {
    const { rows } = await this.pool.query<BeneficiaryRow>(
      `delete from beneficiaries where created_by_mandate_id = $1 returning ${COLUMNS}`,
      [mandateId],
    );
    return rows[0] ? toBeneficiary(rows[0]) : undefined;
  }
}
