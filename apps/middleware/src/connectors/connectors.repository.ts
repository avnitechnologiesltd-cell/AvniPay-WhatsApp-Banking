import { createHash, randomBytes } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import type { MiddlewareConfig } from "@avni/config";
import type { Pool } from "@avni/db";
import { CLOCK, DATABASE_POOL, type Clock } from "@avni/service";

import { open, seal } from "../secrets/encryption";
import { MIDDLEWARE_CONFIG } from "../tokens";
import { parametersSchema, type ConnectorParameter } from "./parameters";

/**
 * The registry, and the credential store behind it.
 *
 * Two properties are this file's whole job, and both are structural rather than
 * a matter of care:
 *
 * - **A credential is write-only.** Nothing outside this class opens one. The
 *   view type below has no field for it, so a route that wanted to leak one
 *   could not be written without adding a field here first — and
 *   `credentialFor` is named for the one caller that has any business with it.
 * - **The key comes from the environment**, never from the row beside the
 *   ciphertext. A database dump that carries its own key is obfuscation with the
 *   word encryption written on it.
 */

export type ConnectorStatus = "active" | "retired";

/**
 * A Connector as the Dashboard, the Support Agent and this codebase see it.
 *
 * The credential's **header** is here and its value is not. The Bank has to be
 * able to see how their own API is being addressed; nobody has to be able to
 * read back what was sent in it.
 */
export interface Connector {
  readonly id: string;
  /** What the Support Agent calls. Lower-case, underscored, Bank-chosen. */
  readonly name: string;
  /** Untrusted model-facing text. Never treated as an instruction. */
  readonly description: string;
  readonly endpoint: string;
  readonly gated: boolean;
  readonly parameters: readonly ConnectorParameter[];
  readonly credentialHeader: string;
  /** When the credential was last entered. Changing one means entering a new one. */
  readonly credentialSetAt: Date;
  readonly status: ConnectorStatus;
  readonly registeredAt: Date;
  readonly registeredBy: string | null;
  readonly updatedAt: Date;
  readonly updatedBy: string | null;
  readonly retiredAt: Date | null;
}

export interface NewConnector {
  readonly name: string;
  readonly description: string;
  readonly endpoint: string;
  readonly gated: boolean;
  readonly parameters: readonly ConnectorParameter[];
  readonly credentialHeader: string;
  /** Entered once. This is the last time it is a value anybody holds. */
  readonly credential: string;
  readonly by: string;
}

/**
 * What an Administrator may change afterwards.
 *
 * The **name** is absent, and deliberately: it is what the Support Agent calls
 * and what every audit row about a dispatch names, so changing it would
 * silently re-point a history. A Connector that needs a different name is a
 * different Connector.
 */
export interface ConnectorChanges {
  readonly description?: string;
  readonly endpoint?: string;
  readonly gated?: boolean;
  readonly parameters?: readonly ConnectorParameter[];
  readonly credentialHeader?: string;
  /** Absent leaves the stored credential alone; present replaces it. */
  readonly credential?: string;
  readonly by: string;
}

/** A Gated dispatch waiting for the Customer's Transaction PIN. */
export interface ConnectorRequest {
  readonly id: string;
  readonly connectorId: string;
  readonly conversationId: string;
  readonly accountNumber: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
  readonly dispatchedAt: Date | null;
}

interface ConnectorRow {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  gated: boolean;
  parameters: unknown;
  credential_header: string;
  credential_set_at: Date;
  status: ConnectorStatus;
  registered_at: Date;
  registered_by: string | null;
  updated_at: Date;
  updated_by: string | null;
  retired_at: Date | null;
}

interface RequestRow {
  id: string;
  connector_id: string;
  conversation_id: string;
  account_number: string;
  arguments: Record<string, unknown>;
  created_at: Date;
  dispatched_at: Date | null;
}

/** Deliberately without `credential_sealed`. See the class doc. */
const COLUMNS = [
  "id",
  "name",
  "description",
  "endpoint",
  "gated",
  "parameters",
  "credential_header",
  "credential_set_at",
  "status",
  "registered_at",
  "registered_by",
  "updated_at",
  "updated_by",
  "retired_at",
].join(", ");

const REQUEST_COLUMNS =
  "id, connector_id, conversation_id::text, account_number, arguments, created_at, dispatched_at";

const toConnector = (row: ConnectorRow): Connector => ({
  id: row.id,
  name: row.name,
  description: row.description,
  endpoint: row.endpoint,
  gated: row.gated,
  // Parsed rather than cast. The column is jsonb and the rows in it were
  // written by a form; a shape that no longer matches must not reach the code
  // that decides whether the model's arguments are acceptable.
  parameters: parametersSchema.safeParse(row.parameters).data ?? [],
  credentialHeader: row.credential_header,
  credentialSetAt: row.credential_set_at,
  status: row.status,
  registeredAt: row.registered_at,
  registeredBy: row.registered_by,
  updatedAt: row.updated_at,
  updatedBy: row.updated_by,
  retiredAt: row.retired_at,
});

const toRequest = (row: RequestRow): ConnectorRequest => ({
  id: row.id,
  connectorId: row.connector_id,
  conversationId: row.conversation_id,
  accountNumber: row.account_number,
  arguments: row.arguments ?? {},
  createdAt: row.created_at,
  dispatchedAt: row.dispatched_at,
});

/** The surface token is a bearer credential, so only its hash is stored. */
const hashToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class ConnectorsRepository {
  public constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(MIDDLEWARE_CONFIG) private readonly config: MiddlewareConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // --- The registry ----------------------------------------------------------

  public async register(connector: NewConnector): Promise<Connector> {
    const { rows } = await this.pool.query<ConnectorRow>(
      `insert into connectors
         (name, description, endpoint, gated, parameters, credential_header, credential_sealed,
          credential_set_at, registered_at, registered_by, updated_at, updated_by)
       values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $8, $9, $8, $9)
       returning ${COLUMNS}`,
      [
        connector.name,
        connector.description,
        connector.endpoint,
        connector.gated,
        JSON.stringify(connector.parameters),
        connector.credentialHeader,
        seal(this.config.credentialEncryptionKey, connector.credential),
        this.clock.now(),
        connector.by,
      ],
    );

    return toConnector(rows[0] as ConnectorRow);
  }

  /**
   * Applies what an Administrator changed, and **only** what they changed.
   *
   * An absent credential leaves the sealed one alone, which is what makes
   * *"edit the description"* a thing somebody can do without holding the Bank's
   * API key in their hand.
   */
  public async change(id: string, changes: ConnectorChanges): Promise<Connector | undefined> {
    if (!UUID.test(id)) return undefined;

    const sets: string[] = ["updated_at = $2", "updated_by = $3"];
    const values: unknown[] = [id, this.clock.now(), changes.by];

    const set = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };

    if (changes.description !== undefined) set("description", changes.description);
    if (changes.endpoint !== undefined) set("endpoint", changes.endpoint);
    if (changes.gated !== undefined) set("gated", changes.gated);
    if (changes.parameters !== undefined) {
      values.push(JSON.stringify(changes.parameters));
      sets.push(`parameters = $${values.length}::jsonb`);
    }
    if (changes.credentialHeader !== undefined) set("credential_header", changes.credentialHeader);
    if (changes.credential !== undefined) {
      set("credential_sealed", seal(this.config.credentialEncryptionKey, changes.credential));
      set("credential_set_at", this.clock.now());
    }

    const { rows } = await this.pool.query<ConnectorRow>(
      `update connectors set ${sets.join(", ")}
       where id = $1 and status = 'active'
       returning ${COLUMNS}`,
      values,
    );
    return rows[0] ? toConnector(rows[0]) : undefined;
  }

  /**
   * Takes a Connector out of the Support Agent's reach, in the next turn.
   *
   * The row survives, because the audit rows about every dispatch through it
   * name this id and evidence with a dangling reference is evidence nobody can
   * read back.
   */
  public async retire(id: string, by: string): Promise<Connector | undefined> {
    if (!UUID.test(id)) return undefined;

    const { rows } = await this.pool.query<ConnectorRow>(
      `update connectors
         set status = 'retired', retired_at = $2, retired_by = $3, updated_at = $2, updated_by = $3
       where id = $1 and status = 'active'
       returning ${COLUMNS}`,
      [id, this.clock.now(), by],
    );
    return rows[0] ? toConnector(rows[0]) : undefined;
  }

  /** Everything ever registered, newest first. The Dashboard's list. */
  public async all(): Promise<readonly Connector[]> {
    const { rows } = await this.pool.query<ConnectorRow>(
      `select ${COLUMNS} from connectors order by registered_at desc`,
    );
    return rows.map(toConnector);
  }

  /** What the Support Agent may be offered: the active ones, oldest first. */
  public async active(): Promise<readonly Connector[]> {
    const { rows } = await this.pool.query<ConnectorRow>(
      `select ${COLUMNS} from connectors where status = 'active' order by registered_at asc`,
    );
    return rows.map(toConnector);
  }

  public async find(id: string): Promise<Connector | undefined> {
    if (!UUID.test(id)) return undefined;

    const { rows } = await this.pool.query<ConnectorRow>(
      `select ${COLUMNS} from connectors where id = $1`,
      [id],
    );
    return rows[0] ? toConnector(rows[0]) : undefined;
  }

  /**
   * **The only method that opens a credential**, and it is named for its one
   * caller: the dispatcher, on the way out to the Bank's own endpoint.
   *
   * There is no route, no view type and no Dashboard screen behind which this
   * value can be read. Changing a credential means entering a new one.
   */
  public async credentialFor(id: string): Promise<string | undefined> {
    if (!UUID.test(id)) return undefined;

    const { rows } = await this.pool.query<{ credential_sealed: string }>(
      "select credential_sealed from connectors where id = $1",
      [id],
    );
    const sealed = rows[0]?.credential_sealed;
    return sealed === undefined ? undefined : open(this.config.credentialEncryptionKey, sealed);
  }

  // --- A Gated call, between the Agent asking and the Customer authorising ----

  /**
   * Records a dispatch waiting for a PIN, and mints the token that names it.
   *
   * The arguments are stored here rather than carried by the handset for the
   * same reason a Mandate's amount is: a sealed surface's payload may carry what
   * the Customer newly supplies and never a value the server rendered, so what
   * is dispatched is read from this row and a tampered payload changes nothing.
   */
  public async requestDispatch(request: {
    readonly connectorId: string;
    readonly conversationId: string;
    readonly accountNumber: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  }): Promise<string> {
    const token = randomBytes(32).toString("base64url");

    await this.pool.query(
      `insert into connector_requests
         (token_hash, connector_id, conversation_id, account_number, arguments, created_at)
       values ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        hashToken(token),
        request.connectorId,
        request.conversationId,
        request.accountNumber,
        JSON.stringify(request.arguments),
        this.clock.now(),
      ],
    );

    return token;
  }

  public async requestByToken(token: string | undefined): Promise<ConnectorRequest | undefined> {
    if (!token) return undefined;

    const { rows } = await this.pool.query<RequestRow>(
      `select ${REQUEST_COLUMNS} from connector_requests where token_hash = $1`,
      [hashToken(token)],
    );
    return rows[0] ? toRequest(rows[0]) : undefined;
  }

  /**
   * Claims a request, once.
   *
   * **Claimed rather than checked**, exactly as a Mandate is: two taps on one
   * screen race each other here, and the loser must not become a second call
   * against the Bank's API. `undefined` means somebody else already had it.
   */
  public async claim(id: string): Promise<ConnectorRequest | undefined> {
    const { rows } = await this.pool.query<RequestRow>(
      `update connector_requests set dispatched_at = $2
       where id = $1 and dispatched_at is null
       returning ${REQUEST_COLUMNS}`,
      [id, this.clock.now()],
    );
    return rows[0] ? toRequest(rows[0]) : undefined;
  }
}
