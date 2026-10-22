import { ask, type Session } from "./middleware-client";

/**
 * The **Library**: the Bank's own documents, and the only thing the Support
 * Agent is allowed to quote.
 *
 * Two roles again, drawn in the same place and for the same reason Connector
 * registration is Administrator-only: **Library text is model-facing text the
 * Bank writes.** A Support Officer reads it — somebody who has just been handed
 * a conversation needs to check what the Agent was permitted to say — and only
 * an Administrator decides what is in it.
 *
 * The screen this backs exists for one step in particular. **Uploading is not
 * publishing.** Text is extracted, shown back, and nothing is retrievable until
 * a person has looked at it and said yes — because PDF extraction fails
 * silently, and a two-column policy that came out as interleaved nonsense is
 * something only a human notices, ideally before a Customer does.
 */

export type LibraryVersionStatus = "draft" | "live" | "withdrawn" | "superseded";

export interface LibraryVersion {
  readonly id: string;
  readonly documentId: string;
  readonly documentTitle: string;
  /** `YYYY-MM-DD`. The Bank's date for the policy, not the day it was uploaded. */
  readonly versionDate: string;
  readonly status: LibraryVersionStatus;
  readonly sourceName: string;
  readonly sourceMediaType: string;
  readonly sectionCount: number;
  /** What handing the whole document to the model would cost, in tokens. */
  readonly tokenEstimate: number;
  readonly uploadedAt: string;
  readonly publishedAt: string | null;
  readonly retiredAt: string | null;
}

export interface LibraryDocument {
  readonly id: string;
  readonly title: string;
  readonly versions: readonly LibraryVersion[];
}

/** One section, exactly as the Support Agent would be handed it. */
export interface LibrarySection {
  readonly ordinal: number;
  readonly heading: string;
  readonly body: string;
  readonly tokenEstimate: number;
}

export const readLibrary = async (session: Session): Promise<readonly LibraryDocument[]> => {
  const body = await ask<{ documents: readonly LibraryDocument[] }>(
    session,
    "/dashboard/library",
    "the Library read",
  );
  return body.documents;
};

/**
 * One version and its sections — **the preview an Administrator approves**.
 *
 * Rendered from the sections rather than from a separate copy of the text, so a
 * document that extracted as nonsense *and* a document that split into one
 * enormous section are both visible in the same glance. There is no second copy
 * of a Library document's text anywhere, which is what makes withdrawing one
 * complete the moment it commits.
 */
export const readLibraryVersion = async (
  session: Session,
  versionId: string,
): Promise<{ version: LibraryVersion; sections: readonly LibrarySection[] }> =>
  ask(
    session,
    `/dashboard/library/versions/${encodeURIComponent(versionId)}`,
    "a Library version read",
  );

export interface LibraryUpload {
  readonly title: string;
  /** Set when this is a new version of a document that already exists. */
  readonly documentId?: string;
  readonly versionDate: string;
  readonly mediaType: string;
  readonly fileName: string;
  /** The file, base64. See the endpoint for why it is not multipart. */
  readonly content: string;
}

export const uploadToLibrary = async (
  session: Session,
  upload: LibraryUpload,
): Promise<{ documentId: string; versionId: string }> =>
  ask(session, "/dashboard/library", "a Library upload", { method: "POST", body: upload });

/** The separate, explicit step. From here the Support Agent may quote it. */
export const publishLibraryVersion = (session: Session, versionId: string): Promise<unknown> =>
  ask(
    session,
    `/dashboard/library/versions/${encodeURIComponent(versionId)}/publish`,
    "a Library publication",
    { method: "POST", body: {} },
  );

/** Out of reach in the very next turn. Nothing to re-index, no cache to clear. */
export const withdrawLibraryVersion = (session: Session, versionId: string): Promise<unknown> =>
  ask(
    session,
    `/dashboard/library/versions/${encodeURIComponent(versionId)}/withdraw`,
    "a Library withdrawal",
    { method: "POST", body: {} },
  );

/** Only ever a draft. A published version is the Bank's record and stays. */
export const discardLibraryDraft = (session: Session, versionId: string): Promise<unknown> =>
  ask(
    session,
    `/dashboard/library/versions/${encodeURIComponent(versionId)}/discard`,
    "a Library draft discard",
    { method: "POST", body: {} },
  );

/** What an Administrator may upload, as the file picker and the endpoint agree. */
export const LIBRARY_MEDIA_TYPES = ["application/pdf", "text/plain", "text/markdown"] as const;

/**
 * The media type for a file the browser could not name.
 *
 * A `.md` file arrives from most browsers as `text/markdown`, from some as
 * `text/plain`, and from a few as `""`. The extension is the tiebreak, and
 * plain text is the fallback — the extractor reads both identically, so the
 * worst outcome of guessing wrong between them is nothing at all.
 */
export const mediaTypeOf = (file: { readonly name: string; readonly type: string }): string => {
  if ((LIBRARY_MEDIA_TYPES as readonly string[]).includes(file.type)) return file.type;
  if (/\.pdf$/i.test(file.name)) return "application/pdf";
  if (/\.(md|markdown)$/i.test(file.name)) return "text/markdown";
  if (/\.txt$/i.test(file.name)) return "text/plain";
  return file.type || "application/octet-stream";
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * `2026-03-01` becomes `1 March 2026` — **the words a Customer is shown.**
 *
 * The Support Agent renders the citation the same way on the other side of the
 * wire, and this is a second implementation of four lines rather than a shared
 * one on purpose: the Dashboard is a separate deployable talking over HTTP, and
 * this whole module declares its types locally for that reason. What keeps the
 * two honest is `tests/support-agent.test.ts`, which asserts the sentence a
 * Customer actually receives.
 *
 * Spelt out because `01/03/2026` means two different days depending on who is
 * reading it, which is not a thing to be ambiguous about in a citation.
 */
export const versionDateInWords = (versionDate: string): string => {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(versionDate);
  if (!parts) return versionDate;

  const month = MONTHS[Number(parts[2]) - 1];
  return month ? `${Number(parts[3])} ${month} ${parts[1]}` : versionDate;
};

/** How a status reads on the screen. `live` is the only one that means anything. */
export const STATUS_WORDS: Readonly<Record<LibraryVersionStatus, string>> = {
  draft: "Draft — not retrievable",
  live: "Live — the Support Agent may quote this",
  withdrawn: "Withdrawn",
  superseded: "Superseded by a newer version",
};
