import { Inject, Injectable } from "@nestjs/common";

import type { Pool } from "@avni/db";
import { CLOCK, DATABASE_POOL, type Clock } from "@avni/service";

import type { Section } from "./sections";

/**
 * The **Library**, as rows.
 *
 * Two properties in here are the whole slice and both are held by the database
 * rather than by the code above it:
 *
 * - **Exactly one version of a document is live**, by a partial unique index.
 * - **Retrieval reads live versions only**, by a predicate in the one query
 *   that retrieves. Unpublishing is therefore complete the moment the update
 *   commits — there is no index to rebuild and no cache to invalidate, because
 *   this is the only copy of the text there is.
 */

export type LibraryVersionStatus = "draft" | "live" | "withdrawn" | "superseded";

/** One version, as the Dashboard lists it. Never the text — see {@link sectionsOf}. */
export interface LibraryVersion {
  readonly id: string;
  readonly documentId: string;
  readonly documentTitle: string;
  /** The Bank's own date for the policy, as `YYYY-MM-DD`. A citation names it. */
  readonly versionDate: string;
  readonly status: LibraryVersionStatus;
  readonly sourceName: string;
  readonly sourceMediaType: string;
  readonly sectionCount: number;
  /** What retrieving every section of it would cost. See `estimateTokens`. */
  readonly tokenEstimate: number;
  readonly uploadedAt: Date;
  readonly uploadedBy: string | null;
  readonly publishedAt: Date | null;
  readonly retiredAt: Date | null;
}

/** One document and every version of it, newest upload first. */
export interface LibraryDocument {
  readonly id: string;
  readonly title: string;
  readonly versions: readonly LibraryVersion[];
}

/**
 * One section, as the Support Agent is given it — **and as it is cited.**
 *
 * The three fields of a citation are on the row rather than composed later,
 * because a citation the Agent cannot make is an answer the Agent may not give.
 * There is no shape in this system where retrieved text arrives without the
 * document title, the section and the version date attached to it.
 */
export interface RetrievedSection {
  readonly documentTitle: string;
  readonly heading: string;
  readonly versionDate: string;
  readonly text: string;
  readonly tokenEstimate: number;
}

interface VersionRow {
  id: string;
  document_id: string;
  document_title: string;
  version_date: string;
  status: string;
  source_name: string;
  source_media_type: string;
  section_count: string | number;
  token_estimate: string | number | null;
  uploaded_at: Date;
  uploaded_by: string | null;
  published_at: Date | null;
  retired_at: Date | null;
}

/**
 * Every column the Dashboard reads, with the section tallies joined on.
 *
 * `source_key` is **not** in here and never leaves this file. An object key is
 * an address in the Bank's storage; a Dashboard session that held one could ask
 * for objects it was never shown, and the Officer-facing payloads keep the same
 * rule the attachment route already keeps.
 */
const VERSION_COLUMNS = `
  v.id, v.document_id, d.title as document_title,
  to_char(v.version_date, 'YYYY-MM-DD') as version_date,
  v.status, v.source_name, v.source_media_type,
  v.uploaded_at, v.uploaded_by, v.published_at, v.retired_at,
  coalesce(s.section_count, 0) as section_count,
  coalesce(s.token_estimate, 0) as token_estimate`;

const VERSION_FROM = `
  from library_versions v
  join library_documents d on d.id = v.document_id
  left join (
    select version_id, count(*) as section_count, sum(token_estimate) as token_estimate
    from library_sections group by version_id
  ) s on s.version_id = v.id`;

const toVersion = (row: VersionRow): LibraryVersion => ({
  id: row.id,
  documentId: row.document_id,
  documentTitle: row.document_title,
  versionDate: row.version_date,
  status: row.status as LibraryVersionStatus,
  sourceName: row.source_name,
  sourceMediaType: row.source_media_type,
  sectionCount: Number(row.section_count),
  tokenEstimate: Number(row.token_estimate ?? 0),
  uploadedAt: row.uploaded_at,
  uploadedBy: row.uploaded_by,
  publishedAt: row.published_at,
  retiredAt: row.retired_at,
});

@Injectable()
export class LibraryRepository {
  public constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // --- Ingestion ------------------------------------------------------------

  /**
   * A new draft, and the document it belongs to if it is the first of them.
   *
   * **It arrives as a draft and there is no argument to make it anything else.**
   * Publishing is a separate call an Administrator makes after looking at the
   * text, and the absence of a parameter here is what makes "a draft is never
   * retrievable" a fact about the shape of this repository rather than a rule
   * somebody has to remember at each call site.
   */
  public async draft(input: {
    readonly documentId?: string;
    readonly title: string;
    readonly versionDate: string;
    readonly sourceKey: string;
    readonly sourceMediaType: string;
    readonly sourceName: string;
    readonly sections: readonly Section[];
    readonly by: string;
  }): Promise<{ readonly documentId: string; readonly versionId: string }> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");

      const documentId =
        input.documentId ??
        (
          await client.query<{ id: string }>(
            "insert into library_documents (title, created_by) values ($1, $2) returning id",
            [input.title, input.by],
          )
        ).rows[0]?.id;

      if (!documentId) throw new Error("The Library document could not be created.");

      const { rows } = await client.query<{ id: string }>(
        `insert into library_versions
           (document_id, version_date, source_key, source_media_type, source_name, uploaded_by)
         values ($1, $2::date, $3, $4, $5, $6)
         returning id`,
        [
          documentId,
          input.versionDate,
          input.sourceKey,
          input.sourceMediaType,
          input.sourceName,
          input.by,
        ],
      );
      const versionId = rows[0]?.id;
      if (!versionId) throw new Error("The Library version could not be created.");

      for (const section of input.sections) {
        await client.query(
          `insert into library_sections (version_id, ordinal, heading, body, token_estimate)
           values ($1, $2, $3, $4, $5)`,
          [versionId, section.ordinal, section.heading, section.body, section.tokenEstimate],
        );
      }

      await client.query("commit");
      return { documentId, versionId };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Publishes a draft, and retires whatever was live in the same statement.
   *
   * One transaction rather than two calls, because the moment between them is a
   * moment in which a document has two live versions or none — and the Agent
   * would quote whichever the planner reached first. The partial unique index
   * would refuse the first case anyway; this makes it not arise.
   */
  public async publish(
    versionId: string,
    by: string,
  ): Promise<
    | { readonly outcome: "published"; readonly version: LibraryVersion }
    | { readonly outcome: "not_a_draft"; readonly status: LibraryVersionStatus }
    | { readonly outcome: "not_found" }
  > {
    const now = this.clock.now();
    const client = await this.pool.connect();
    try {
      await client.query("begin");

      const { rows: current } = await client.query<{ document_id: string; status: string }>(
        "select document_id, status from library_versions where id = $1 for update",
        [versionId],
      );
      const found = current[0];
      if (!found) {
        await client.query("rollback");
        return { outcome: "not_found" };
      }
      if (found.status !== "draft") {
        await client.query("rollback");
        return { outcome: "not_a_draft", status: found.status as LibraryVersionStatus };
      }

      await client.query(
        `update library_versions
         set status = 'superseded', retired_at = $3, retired_by = $2
         where document_id = $1 and status = 'live'`,
        [found.document_id, by, now],
      );
      await client.query(
        `update library_versions
         set status = 'live', published_at = $2, published_by = $3
         where id = $1`,
        [versionId, now, by],
      );

      await client.query("commit");

      const published = await this.version(versionId);
      // Read back rather than assembled from what was just written, so what the
      // Dashboard renders is the row rather than this method's belief about it.
      // It cannot be missing — the update above committed — and it is handled
      // rather than asserted, because `as LibraryVersion` would be this file
      // telling the compiler something it cannot know.
      if (!published) return { outcome: "not_found" };
      return { outcome: "published", version: published };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Takes a live version out of reach. **Complete when this returns**, because
   * the next retrieval reads these same rows and there is no second copy.
   */
  public async withdraw(
    versionId: string,
    by: string,
  ): Promise<
    | { readonly outcome: "withdrawn"; readonly version: LibraryVersion }
    | { readonly outcome: "not_live"; readonly status: LibraryVersionStatus }
    | { readonly outcome: "not_found" }
  > {
    const { rows } = await this.pool.query<{ status: string }>(
      `update library_versions
       set status = 'withdrawn', retired_at = $2, retired_by = $3
       where id = $1 and status = 'live'
       returning status`,
      [versionId, this.clock.now(), by],
    );

    const existing = await this.version(versionId);
    if (!existing) return { outcome: "not_found" };

    // One read, used two ways: the row after a successful update, or the reason
    // there was not one.
    return rows[0]
      ? { outcome: "withdrawn", version: existing }
      : { outcome: "not_live", status: existing.status };
  }

  /**
   * Throws away a draft nobody published.
   *
   * Only a draft, and that is the whole rule. A draft was never retrievable, so
   * nothing was ever quoted from it and there is nothing for the Bank to
   * reconstruct; a published version is evidence of what a Customer may have
   * been told, and evidence is not something this platform deletes.
   */
  public async discardDraft(
    versionId: string,
  ): Promise<{ readonly outcome: "discarded" | "not_a_draft" | "not_found" }> {
    const { rowCount } = await this.pool.query(
      "delete from library_versions where id = $1 and status = 'draft'",
      [versionId],
    );
    if ((rowCount ?? 0) > 0) return { outcome: "discarded" };

    return { outcome: (await this.version(versionId)) ? "not_a_draft" : "not_found" };
  }

  // --- Reading, for the Dashboard -------------------------------------------

  /** Every document, with every version of each. Newest document first. */
  public async documents(): Promise<readonly LibraryDocument[]> {
    const { rows } = await this.pool.query<VersionRow>(
      `select ${VERSION_COLUMNS} ${VERSION_FROM} order by d.created_at desc, v.uploaded_at desc`,
    );

    const documents = new Map<string, { id: string; title: string; versions: LibraryVersion[] }>();
    for (const row of rows) {
      const version = toVersion(row);
      const existing = documents.get(version.documentId);
      if (existing) existing.versions.push(version);
      else {
        documents.set(version.documentId, {
          id: version.documentId,
          title: version.documentTitle,
          versions: [version],
        });
      }
    }
    return [...documents.values()];
  }

  public async version(versionId: string): Promise<LibraryVersion | undefined> {
    const { rows } = await this.pool.query<VersionRow>(
      `select ${VERSION_COLUMNS} ${VERSION_FROM} where v.id = $1`,
      [versionId],
    );
    return rows[0] ? toVersion(rows[0]) : undefined;
  }

  /**
   * The extracted text of one version, in reading order.
   *
   * **This is the preview an Administrator approves before publishing**, and it
   * is rendered from the sections rather than from a separate copy of the text.
   * That is not tidiness: it means a document that extracted as interleaved
   * nonsense *and* a document that split into one enormous section are both
   * visible in the same glance, and it means what a human approved is exactly
   * what the Agent will be given.
   */
  public async sectionsOf(versionId: string): Promise<readonly Section[]> {
    const { rows } = await this.pool.query<{
      ordinal: number;
      heading: string;
      body: string;
      token_estimate: number;
    }>(
      `select ordinal, heading, body, token_estimate
       from library_sections where version_id = $1 order by ordinal`,
      [versionId],
    );

    return rows.map((row) => ({
      ordinal: row.ordinal,
      heading: row.heading,
      body: row.body,
      tokenEstimate: row.token_estimate,
    }));
  }

  /** The object key of one version's original file. Never leaves the Middleware. */
  public async sourceKeyOf(
    versionId: string,
  ): Promise<{ readonly key: string; readonly mediaType: string } | undefined> {
    const { rows } = await this.pool.query<{ source_key: string; source_media_type: string }>(
      "select source_key, source_media_type from library_versions where id = $1",
      [versionId],
    );
    const row = rows[0];
    return row ? { key: row.source_key, mediaType: row.source_media_type } : undefined;
  }

  // --- Retrieval, for the Support Agent -------------------------------------

  /**
   * Top matching sections of **live versions only**, within a token budget.
   *
   * The `status = 'live'` predicate is the single line that makes a withdrawn
   * policy unquotable in the very next turn. It is not an optimisation and not a
   * filter applied afterwards — there is no path in this system that reads a
   * section without it, because this is the only method that reads one for a
   * model.
   *
   * The query is built from the Customer's own words with every character that
   * is not a letter or a digit removed, so a tsquery operator cannot be typed
   * into a chat. Words are joined with `|` rather than `&`: a Customer asking
   * *"what do you charge to send money to another bank"* would match nothing
   * under `&`, and finding nothing is a Handoff — a real question turned into a
   * queue entry by a boolean.
   */
  public async retrieve(
    query: string,
    budgetTokens: number,
  ): Promise<readonly RetrievedSection[]> {
    const words = lexemesIn(query);
    if (words.length === 0) return [];

    const { rows } = await this.pool.query<{
      document_title: string;
      heading: string;
      version_date: string;
      body: string;
      token_estimate: number;
    }>(
      `select d.title as document_title,
              s.heading,
              to_char(v.version_date, 'YYYY-MM-DD') as version_date,
              s.body,
              s.token_estimate
       from library_sections s
       join library_versions v on v.id = s.version_id
       join library_documents d on d.id = v.document_id,
            to_tsquery('english', $1) as q
       where v.status = 'live' and s.search @@ q
       order by ts_rank_cd(s.search, q) desc, v.version_date desc, s.ordinal
       limit $2`,
      [words.join(" | "), CANDIDATES],
    );

    // **The budget is applied here and the retrieval stops at it.** It is a
    // capacity control rather than a quality knob: the ceiling is Groq's 250K
    // TPM, and anything in the preamble multiplies against every turn of every
    // conversation. A corpus that grows must not silently start costing the
    // Bank its throughput.
    const kept: RetrievedSection[] = [];
    let spent = 0;
    for (const row of rows) {
      if (spent + row.token_estimate > budgetTokens) continue;
      spent += row.token_estimate;
      kept.push({
        documentTitle: row.document_title,
        heading: row.heading,
        versionDate: row.version_date,
        text: row.body,
        tokenEstimate: row.token_estimate,
      });
    }
    return kept;
  }
}

/**
 * How many ranked candidates are considered before the budget is applied.
 *
 * Generous, because the budget below is what actually bounds the payload and a
 * tight limit here would let one long section starve out five short ones that
 * would all have fitted.
 */
const CANDIDATES = 40;

/**
 * The Customer's words, reduced to something that cannot be a tsquery operator.
 *
 * Everything that is not a letter or a digit goes, which removes `&`, `|`, `!`,
 * `:*` and the brackets in one rule rather than in five. Single characters go
 * too — they match half the corpus and rank nothing.
 */
const lexemesIn = (query: string): readonly string[] =>
  [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 1)
        .slice(0, 40),
    ),
  ];
