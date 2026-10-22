import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { formatWhen } from "../../../format";
import {
  STATUS_WORDS,
  readLibraryVersion,
  versionDateInWords,
  type LibrarySection,
  type LibraryVersion,
} from "../../../library";
import { currentSession } from "../../../session";
import { readingAsOfficer } from "../../guard";
import { StaffBar } from "../../staff-bar";
import {
  button,
  card,
  dangerButton,
  heading,
  muted,
  notice,
  page,
  subheading,
} from "../../ui";
import { discardDraft, publishVersion, withdrawVersion } from "../actions";

export const dynamic = "force-dynamic";

/**
 * **The screen the whole ingestion design exists for.**
 *
 * PDF extraction fails silently. A two-column policy comes out as every line of
 * the left column glued to the line beside it, and nothing in the platform can
 * tell that from a document that read perfectly — a person can, at a glance, and
 * this is where they do it. Without this step nobody discovers the nonsense
 * until the Support Agent quotes it to a Customer.
 *
 * It renders the **sections**, not a blob of text, and that is deliberate: they
 * are the grain the Agent retrieves at and the grain a citation names, so a
 * document that split badly is visible in the same glance as one that extracted
 * badly. There is no second copy of the text anywhere — what is on this page is
 * the rows the Agent will read.
 */
const LibraryVersionPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ versionId: string }>;
  searchParams: Promise<{ problem?: string; saved?: string; uploaded?: string }>;
}): Promise<ReactNode> => {
  const session = await currentSession();
  if (!session) redirect("/sign-in");

  const administrator = session.account.role === "administrator";
  const { versionId } = await params;
  const { problem, saved, uploaded } = await searchParams;

  const { version, sections } = await readingAsOfficer(() =>
    readLibraryVersion(session, versionId),
  );

  return (
    <main style={page}>
      <StaffBar account={session.account} />
      <p style={muted}>
        <Link href="/library">← Library</Link>
      </p>
      <h1 style={heading}>{version.documentTitle}</h1>
      <p style={muted}>
        {versionDateInWords(version.versionDate)} · {STATUS_WORDS[version.status]}
      </p>

      {problem ? <p style={notice}>{problem}</p> : null}
      {saved && !problem ? <p style={muted}>Saved.</p> : null}
      {uploaded && !problem ? (
        <p style={notice}>
          This is a draft. <strong>The Support Agent cannot see it.</strong> Read the text below —
          this is exactly what the Agent would be given — and publish it if it reads correctly.
        </p>
      ) : null}

      <Details version={version} />
      {administrator ? <Controls version={version} /> : null}

      <h2 style={subheading}>The text, as the Support Agent would read it</h2>
      {sections.length === 0 ? (
        <p style={notice}>No text came out of this document.</p>
      ) : (
        sections.map((section) => (
          <Section key={section.ordinal} section={section} version={version} />
        ))
      )}
    </main>
  );
};

const Details = ({ version }: { version: LibraryVersion }): ReactNode => (
  <dl style={{ ...card, display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.25rem 1rem" }}>
    <dt style={muted}>Uploaded</dt>
    <dd style={{ margin: 0 }}>
      {formatWhen(version.uploadedAt)} · {version.sourceName || "no filename"} (
      {version.sourceMediaType})
    </dd>

    <dt style={muted}>Published</dt>
    <dd style={{ margin: 0 }}>
      {version.publishedAt ? formatWhen(version.publishedAt) : "never"}
    </dd>

    {version.retiredAt ? (
      <>
        <dt style={muted}>Retired</dt>
        <dd style={{ margin: 0 }}>{formatWhen(version.retiredAt)}</dd>
      </>
    ) : null}

    <dt style={muted}>Size</dt>
    <dd style={{ margin: 0 }}>
      {version.sectionCount} sections · about {version.tokenEstimate.toLocaleString()} tokens in
      total
    </dd>
  </dl>
);

/**
 * The three acts, and the screen only ever offers the one that applies.
 *
 * A draft may be published or thrown away. A live version may be withdrawn.
 * Something already retired has nothing left to do to it — and there is no
 * control for deleting one, because a published version is the Bank's
 * record of what a Customer may have been told.
 */
const Controls = ({ version }: { version: LibraryVersion }): ReactNode => {
  if (version.status === "draft") {
    return (
      <div style={{ display: "flex", gap: "0.75rem", margin: "0 0 0.75rem" }}>
        <form action={publishVersion}>
          <input type="hidden" name="versionId" value={version.id} />
          <button type="submit" style={button}>
            Publish — the Agent may quote this
          </button>
        </form>
        <form action={discardDraft}>
          <input type="hidden" name="versionId" value={version.id} />
          <button type="submit" style={dangerButton}>
            Discard this draft
          </button>
        </form>
      </div>
    );
  }

  if (version.status === "live") {
    return (
      <form action={withdrawVersion} style={{ margin: "0 0 0.75rem" }}>
        <input type="hidden" name="versionId" value={version.id} />
        <button type="submit" style={dangerButton}>
          Withdraw — the Agent stops quoting it immediately
        </button>
      </form>
    );
  }

  return null;
};

/**
 * One section, with the citation a Customer would be shown underneath it.
 *
 * Showing the citation here rather than only the text is the point of doing it
 * at section grain at all: an Administrator sees the sentence a Customer will
 * read — *"Funds Transfer Policy, Charges (1 March 2026)"* — and can tell
 * whether the heading it names is a heading anybody would recognise.
 */
const Section = ({
  section,
  version,
}: {
  section: LibrarySection;
  version: LibraryVersion;
}): ReactNode => (
  <article style={card}>
    <h3 style={{ margin: "0 0 0.25rem", fontSize: "1rem" }}>
      {section.heading || <span style={muted}>(before the first heading)</span>}
    </h3>
    <p style={{ ...muted, fontSize: "0.8125rem" }}>
      cited as: {version.documentTitle}
      {section.heading ? `, ${section.heading}` : ""} ({versionDateInWords(version.versionDate)})
      {" · ~"}
      {section.tokenEstimate} tokens
    </p>
    {/* `pre-wrap`, so an extraction that ran two columns together looks wrong
        here rather than being tidied into something that reads plausibly. */}
    <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{section.body}</p>
  </article>
);

export default LibraryVersionPage;
