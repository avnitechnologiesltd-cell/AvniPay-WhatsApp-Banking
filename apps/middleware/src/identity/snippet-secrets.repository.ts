import { randomBytes } from "node:crypto";

import { Inject, Injectable, Logger } from "@nestjs/common";

import type { MiddlewareConfig } from "@avni/config";
import type { Pool } from "@avni/db";
import { CLOCK, DATABASE_POOL, type Clock } from "@avni/service";

import { SealedValueError, open, seal } from "../secrets/encryption";
import { MIDDLEWARE_CONFIG } from "../tokens";
import { CURRENT_CONTRACT_VERSION, type ContractVersion } from "./signed-identity";

/**
 * The signing secrets behind in-app chat.
 *
 * **Shown once at issue and never readable afterwards** — not by the
 * Administrator who generated it, not by the Dashboard, not by any endpoint
 * here. That is the same rule ticket 18 set for Connector credentials, and it
 * holds for the same reason: a surface that can read a secret back is a surface
 * somebody can exfiltrate one through.
 *
 * The Middleware itself reads them, which is unavoidable — it is the verifier,
 * and an HMAC cannot be checked against a hash. So they are sealed rather than
 * hashed, under a key from the environment, and `secretsForVerification` is the
 * only method that opens one.
 */

/** A secret as anybody but the verifier may see it: everything except itself. */
export interface SnippetSecretRecord {
  readonly id: string;
  readonly label: string;
  readonly contractVersion: string;
  readonly issuedBy: string | null;
  readonly issuedAt: Date;
  readonly revokedAt: Date | null;
}

interface SnippetSecretRow {
  id: string;
  sealed_secret: string;
  contract_version: string;
  label: string;
  issued_by: string | null;
  issued_at: Date;
  revoked_at: Date | null;
}

const COLUMNS =
  "id, sealed_secret, contract_version, label, issued_by, issued_at, revoked_at";

const toRecord = (row: SnippetSecretRow): SnippetSecretRecord => ({
  id: row.id,
  label: row.label,
  contractVersion: row.contract_version,
  issuedBy: row.issued_by,
  issuedAt: row.issued_at,
  revokedAt: row.revoked_at,
});

/** What issuing produces. The `secret` is the only time anybody sees it. */
export interface IssuedSnippetSecret {
  readonly secret: string;
  readonly record: SnippetSecretRecord;
}

@Injectable()
export class SnippetSecretsRepository {
  private readonly logger = new Logger(SnippetSecretsRepository.name);

  public constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(MIDDLEWARE_CONFIG) private readonly config: MiddlewareConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Mints a secret, seals it, and hands the plaintext back exactly once.
   *
   * 32 bytes of randomness rather than a memorable string: this is pasted into
   * a backend's configuration by an engineer, never typed by anybody, so there
   * is no case for it being shorter than the digest it will key.
   */
  public async issue(options: {
    readonly label?: string;
    readonly issuedBy?: string;
    readonly contractVersion?: ContractVersion;
  } = {}): Promise<IssuedSnippetSecret> {
    const secret = randomBytes(32).toString("base64url");
    const contractVersion = options.contractVersion ?? CURRENT_CONTRACT_VERSION;

    const { rows } = await this.pool.query<SnippetSecretRow>(
      `insert into snippet_secrets (sealed_secret, contract_version, label, issued_by, issued_at)
       values ($1, $2, $3, $4, $5)
       returning ${COLUMNS}`,
      [
        seal(this.config.credentialEncryptionKey, secret),
        contractVersion,
        options.label ?? "",
        options.issuedBy ?? null,
        this.clock.now(),
      ],
    );

    return { secret, record: toRecord(rows[0] as SnippetSecretRow) };
  }

  /** Every secret ever issued, as metadata. Never the secret. */
  public async list(): Promise<readonly SnippetSecretRecord[]> {
    const { rows } = await this.pool.query<SnippetSecretRow>(
      `select ${COLUMNS} from snippet_secrets order by issued_at desc`,
    );
    return rows.map(toRecord);
  }

  /**
   * The live secrets, opened — **the only path in this codebase that recovers
   * one**, and the reason it is named for what it is for rather than for what
   * it returns.
   *
   * A row that will not open is logged and skipped rather than thrown. The
   * ordinary cause is the encryption key having been changed, and one
   * unreadable row must not stop the other secrets verifying anybody.
   */
  public async secretsForVerification(): Promise<readonly string[]> {
    const { rows } = await this.pool.query<SnippetSecretRow>(
      `select ${COLUMNS} from snippet_secrets where revoked_at is null order by issued_at desc`,
    );

    return rows.flatMap((row) => {
      try {
        return [open(this.config.credentialEncryptionKey, row.sealed_secret)];
      } catch (error) {
        this.logger.error({
          event: "snippet_secret_unreadable",
          secretId: row.id,
          reason: error instanceof SealedValueError ? error.message : String(error),
        });
        return [];
      }
    });
  }

  /**
   * Retires one secret. Every envelope signed with it stops verifying on the
   * next message, which is what makes a leaked secret killable without a
   * redeploy and without breaking the Bank's other integrations.
   *
   * **Not audited here.** The Dashboard surface records the attempt before it
   * acts, with who asked and which secret, exactly as it does for every other
   * action — and a second row from underneath would say the same thing twice.
   */
  public async revoke(id: string): Promise<boolean> {
    if (!UUID.test(id)) return false;

    const { rows } = await this.pool.query<SnippetSecretRow>(
      `update snippet_secrets set revoked_at = $2
       where id = $1 and revoked_at is null
       returning ${COLUMNS}`,
      [id, this.clock.now()],
    );
    return rows[0] !== undefined;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
