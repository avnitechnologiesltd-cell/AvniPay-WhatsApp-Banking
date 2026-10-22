import { randomBytes } from "node:crypto";

import { Inject, Injectable, Logger } from "@nestjs/common";

import type { ObjectStore } from "@avni/service";

import type { Actor } from "../audit/actions";
import { AuditRepository } from "../audit/audit.repository";
import { LIBRARY_STORE } from "../tokens";
import { extract, isLibraryMediaType } from "./extraction";
import {
  LibraryRepository,
  type LibraryDocument,
  type LibraryVersion,
  type RetrievedSection,
} from "./library.repository";
import { sectionsIn, type Section } from "./sections";

/**
 * The **Library** — Bank reference material the Support Agent reads as context,
 * and the one thing that makes a cited answer possible.
 *
 * Three rules hold this whole slice up and each of them is a step somebody has
 * to take rather than a sentence in a prompt:
 *
 * - **Uploading is not publishing.** Text is extracted and shown back; nothing
 *   is retrievable until an Administrator has looked at it and said yes. PDF
 *   extraction fails *silently* — a two-column policy comes out as interleaved
 *   nonsense — and without a preview nobody discovers that until the Agent
 *   quotes it to a Customer.
 * - **Unpublishing is immediate.** There is no second copy of the text
 *   anywhere, so a withdrawn policy is unquotable in the very next turn.
 * - **Retrieval is capped.** Not for quality — for capacity. The ceiling is
 *   Groq's 250K TPM and Library text multiplies against every turn of every
 *   conversation.
 *
 * What separates this from a Connector, and the reason it is never Gated and
 * never takes a Transaction PIN: **a Library is read by the model as text, a
 * Connector is called by it as an action.**
 */

export type UploadOutcome =
  | { readonly outcome: "drafted"; readonly documentId: string; readonly versionId: string }
  /** The file is not a kind this can read, or it is and it would not open. */
  | { readonly outcome: "refused"; readonly problem: string };

export interface UploadRequest {
  readonly title: string;
  /** Adding a version to a document that already exists, rather than a new one. */
  readonly documentId?: string;
  /** The Bank's own date for this policy, `YYYY-MM-DD`. A citation names it. */
  readonly versionDate: string;
  readonly mediaType: string;
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

/**
 * The default retrieval budget, in tokens.
 *
 * A **starting value rather than a finding**, and the spec says so: it wants a
 * real corpus and there is none. It is configuration for that reason, and it is
 * a capacity control rather than a quality knob — see the class doc.
 */
export const DEFAULT_RETRIEVAL_BUDGET_TOKENS = 8_000;

@Injectable()
export class LibraryService {
  private readonly logger = new Logger(LibraryService.name);

  public constructor(
    @Inject(LibraryRepository) private readonly library: LibraryRepository,
    @Inject(LIBRARY_STORE) private readonly store: ObjectStore,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
  ) {}

  // --- Ingestion ------------------------------------------------------------

  /**
   * Reads the file, cuts it into sections, and leaves a **draft**.
   *
   * The original goes to object storage and the text goes to Postgres, which
   * looks like a contradiction beside the attachment rule and is not: the
   * Platform moves a Customer's file *without opening it*, and this opens an
   * Administrator's on purpose. The difference is who supplied it.
   *
   * The bytes are stored **after** extraction succeeds. A file nobody could read
   * is a file nobody should be paying to keep, and an object with no row
   * pointing at it is litter in the Bank's bucket forever.
   */
  public async upload(request: UploadRequest, by: Actor): Promise<UploadOutcome> {
    if (!isLibraryMediaType(request.mediaType)) {
      return this.refuse(
        request,
        by,
        `The Library reads PDF, plain text and Markdown. That file is ${request.mediaType}.`,
      );
    }

    const extraction = await extract(request.bytes, request.mediaType);
    if (extraction.outcome === "unreadable") {
      return this.refuse(request, by, extraction.problem);
    }

    const sections = sectionsIn(extraction.text);
    if (sections.length === 0) {
      return this.refuse(request, by, "No sections came out of that document.");
    }

    // Minted here and owing nothing to the filename, exactly as an attachment's
    // key does. A name an Administrator chose is still a name somebody chose,
    // and a key made of one is a path traversal waiting for a bucket that
    // normalises slashes.
    const sourceKey = `library/${randomBytes(16).toString("hex")}`;
    await this.store.put(sourceKey, request.bytes, request.mediaType);

    const drafted = await this.library.draft({
      ...(request.documentId ? { documentId: request.documentId } : {}),
      title: request.title,
      versionDate: request.versionDate,
      sourceKey,
      sourceMediaType: request.mediaType,
      sourceName: request.fileName,
      sections,
      by: staffId(by),
    });

    await this.audit.record({
      action: "library.uploaded",
      actor: by,
      outcome: "succeeded",
      detail: {
        documentId: drafted.documentId,
        versionId: drafted.versionId,
        title: request.title,
        versionDate: request.versionDate,
        mediaType: request.mediaType,
        sections: sections.length,
        tokenEstimate: totalTokens(sections),
      },
    });

    return { outcome: "drafted", ...drafted };
  }

  /**
   * **The separate, explicit step.** An Administrator has read the extracted
   * text and is putting it in front of Customers.
   */
  public async publish(
    versionId: string,
    by: Actor,
  ): Promise<
    | { readonly outcome: "published"; readonly version: LibraryVersion }
    | { readonly outcome: "refused"; readonly problem: string }
  > {
    const published = await this.library.publish(versionId, staffId(by));

    switch (published.outcome) {
      case "published":
        await this.audit.record({
          action: "library.published",
          actor: by,
          outcome: "succeeded",
          detail: {
            versionId,
            documentId: published.version.documentId,
            title: published.version.documentTitle,
            versionDate: published.version.versionDate,
            sections: published.version.sectionCount,
          },
        });
        return published;

      case "not_a_draft":
        return this.refusePublication(versionId, by, "library.published", {
          problem:
            published.status === "live"
              ? "That version is already live."
              : `That version was ${published.status} and cannot be published again.`,
        });

      case "not_found":
        return this.refusePublication(versionId, by, "library.published", {
          problem: "No such Library version.",
        });
    }
  }

  /**
   * Takes a live version out of the Agent's reach, **in the very next turn**.
   *
   * There is nothing to re-index and no cache to clear, which is exactly why the
   * design refuses a second copy anywhere: every extra copy is a place a
   * withdrawn policy survives, and a Support Agent quoting a withdrawn policy is
   * a compliance problem for the Bank.
   */
  public async withdraw(
    versionId: string,
    by: Actor,
  ): Promise<
    | { readonly outcome: "withdrawn"; readonly version: LibraryVersion }
    | { readonly outcome: "refused"; readonly problem: string }
  > {
    const withdrawn = await this.library.withdraw(versionId, staffId(by));

    switch (withdrawn.outcome) {
      case "withdrawn":
        await this.audit.record({
          action: "library.withdrawn",
          actor: by,
          outcome: "succeeded",
          detail: {
            versionId,
            documentId: withdrawn.version.documentId,
            title: withdrawn.version.documentTitle,
            versionDate: withdrawn.version.versionDate,
          },
        });
        return withdrawn;

      case "not_live":
        return this.refusePublication(versionId, by, "library.withdrawn", {
          problem: `That version is ${withdrawn.status}, not live.`,
        });

      case "not_found":
        return this.refusePublication(versionId, by, "library.withdrawn", {
          problem: "No such Library version.",
        });
    }
  }

  /** Throws away a draft. Only ever a draft — see the repository. */
  public async discard(
    versionId: string,
    by: Actor,
  ): Promise<{ readonly outcome: "discarded" } | { readonly outcome: "refused"; readonly problem: string }> {
    const discarded = await this.library.discardDraft(versionId);

    if (discarded.outcome === "discarded") {
      await this.audit.record({
        action: "library.discarded",
        actor: by,
        outcome: "succeeded",
        detail: { versionId },
      });
      return { outcome: "discarded" };
    }

    return this.refusePublication(versionId, by, "library.discarded", {
      problem:
        discarded.outcome === "not_a_draft"
          ? "That version has been published, and a published version is the Bank's record of what a Customer may have been told."
          : "No such Library version.",
    });
  }

  // --- Reading, for the Dashboard -------------------------------------------

  public documents(): Promise<readonly LibraryDocument[]> {
    return this.library.documents();
  }

  public version(versionId: string): Promise<LibraryVersion | undefined> {
    return this.library.version(versionId);
  }

  /** The preview. What an Administrator approves, and what the Agent will get. */
  public sectionsOf(versionId: string): Promise<readonly Section[]> {
    return this.library.sectionsOf(versionId);
  }

  // --- Retrieval, for the Support Agent -------------------------------------

  /**
   * What the Support Agent is given for one turn.
   *
   * **Bank-wide and identical for every Customer**, which is precisely why
   * conversation history is not Library material and never reaches here: a
   * Library is read by every conversation, and a Customer's own words are
   * per-Customer regulated data. One mechanism for two incompatible access rules
   * is how a cross-Customer leak gets built, so there is only one mechanism and
   * it takes no Customer identifier at all — this method's signature is the
   * proof, because there is no argument here to scope by.
   */
  public async retrieve(
    query: string,
    options: { readonly budgetTokens: number; readonly conversationId?: string },
  ): Promise<readonly RetrievedSection[]> {
    const sections = await this.library.retrieve(query, options.budgetTokens);

    await this.audit.record({
      action: "library.retrieved",
      actor: { kind: "platform" },
      // Finding nothing is an ordinary answer here rather than a failure — it is
      // what makes the Agent say it cannot confirm — but it is worth being able
      // to count, because a corpus that answers nothing is a corpus that needs
      // writing.
      outcome: sections.length > 0 ? "succeeded" : "unavailable",
      ...(options.conversationId ? { conversationId: options.conversationId } : {}),
      detail: {
        // The query, because it is what the Agent asked for. Never the sections'
        // text: this table is read during investigations and the text is one
        // join away in a form that cannot go stale.
        query: query.slice(0, 500),
        budgetTokens: options.budgetTokens,
        spentTokens: totalTokens(sections),
        cited: sections.map(
          (section) => `${section.documentTitle} — ${section.heading} (${section.versionDate})`,
        ),
      },
    });

    return sections;
  }

  // --- Refusals, recorded ---------------------------------------------------

  private async refuse(request: UploadRequest, by: Actor, problem: string): Promise<UploadOutcome> {
    this.logger.warn({ event: "library_upload_refused", problem });
    await this.audit.record({
      action: "library.uploaded",
      actor: by,
      outcome: "refused",
      detail: {
        title: request.title,
        mediaType: request.mediaType,
        bytes: request.bytes.byteLength,
        problem,
      },
    });
    return { outcome: "refused", problem };
  }

  private async refusePublication(
    versionId: string,
    by: Actor,
    action: "library.published" | "library.withdrawn" | "library.discarded",
    reason: { readonly problem: string },
  ): Promise<{ readonly outcome: "refused"; readonly problem: string }> {
    await this.audit.record({
      action,
      actor: by,
      outcome: "refused",
      detail: { versionId, problem: reason.problem },
    });
    return { outcome: "refused", problem: reason.problem };
  }
}

const totalTokens = (sections: readonly { readonly tokenEstimate: number }[]): number =>
  sections.reduce((total, section) => total + section.tokenEstimate, 0);

/**
 * The staff id every Library write is attributed to.
 *
 * **Refused rather than defaulted.** These columns are `uuid references
 * staff_accounts (id)`, so an `Actor` with no id would reach Postgres as an
 * invalid-uuid error naming a column — true, and useless to whoever reads it.
 * Every caller is a Dashboard route that has already resolved a session, so this
 * never fires; it is here so that a future caller which has not cannot quietly
 * write an unattributed row into the one table the Bank audits.
 */
const staffId = (by: Actor): string => {
  if (!by.id) throw new Error("A Library change must be attributed to a member of staff.");
  return by.id;
};
