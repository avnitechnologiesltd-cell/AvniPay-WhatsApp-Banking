import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { formatWhen } from "../../format";
import {
  LIBRARY_MEDIA_TYPES,
  STATUS_WORDS,
  readLibrary,
  type LibraryDocument,
  type LibraryVersion,
} from "../../library";
import { currentSession } from "../../session";
import { readingAsOfficer } from "../guard";
import { StaffBar } from "../staff-bar";
import { button, card, cell, field, heading, muted, notice, page, subheading, table } from "../ui";
import { uploadDocument } from "./actions";

/** Never cached. What the Agent may quote is not something to read from a cache. */
export const dynamic = "force-dynamic";

/**
 * **The Bank's own documents, and the only thing the Support Agent may quote.**
 *
 * The Agent may not state a Bank policy it cannot cite. With nothing published
 * it says it cannot confirm and hands off every policy question — coherent and
 * honest on day one, and it improves the moment the Bank publishes anything.
 * This screen is where that happens.
 */
const LibraryPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ problem?: string; saved?: string }>;
}): Promise<ReactNode> => {
  const session = await currentSession();
  if (!session) redirect("/sign-in");

  const administrator = session.account.role === "administrator";
  const { problem, saved } = await searchParams;
  const documents = await readingAsOfficer(() => readLibrary(session));

  return (
    <main style={page}>
      <StaffBar account={session.account} />
      <h1 style={heading}>Library</h1>
      <p style={muted}>
        {administrator
          ? "What the Support Agent is allowed to quote. It may not state a policy it cannot cite, so a question with nothing published behind it becomes a Handoff to one of your team."
          : "What the Support Agent is allowed to quote. Only an Administrator may change any of it."}
      </p>

      {/* Rendered as text, never as markup. It came back on the URL, so the one
          person who can put anything in it is the person reading it. */}
      {problem ? <p style={notice}>{problem}</p> : null}
      {saved && !problem ? <p style={muted}>Saved.</p> : null}

      {administrator ? <UploadForm documents={documents} /> : null}

      <h2 style={subheading}>Documents</h2>
      {documents.length === 0 ? (
        <p style={muted}>
          Nothing is published. The Support Agent answers from its own instructions and hands every
          policy question to a person.
        </p>
      ) : (
        documents.map((document) => <Document key={document.id} document={document} />)
      )}
    </main>
  );
};

/**
 * Uploading, and **nothing here publishes anything**.
 *
 * The version date is asked for rather than taken from the clock, and that is
 * the field worth explaining on the screen: a citation names it, and *"the day
 * somebody dragged the file in"* is not a fact about the Bank's policy.
 */
const UploadForm = ({ documents }: { documents: readonly LibraryDocument[] }): ReactNode => (
  <form action={uploadDocument} style={{ ...card, display: "grid", gap: "0.75rem" }}>
    <h2 style={{ ...subheading, margin: 0 }}>Upload a document</h2>
    <p style={muted}>
      It arrives as a draft. You will see the text that came out of it, and publishing is a separate
      step — a PDF that extracted badly is something only a person notices.
    </p>

    <label>
      Title
      <input name="title" style={field} maxLength={200} required />
    </label>

    <label>
      Version date
      <input name="versionDate" type="date" style={field} required />
      <span style={muted}>
        The Bank&rsquo;s own date for this policy. The Support Agent cites it to Customers.
      </span>
    </label>

    <label>
      New version of
      <select name="documentId" style={field} defaultValue="">
        <option value="">A new document</option>
        {documents.map((document) => (
          <option key={document.id} value={document.id}>
            {document.title}
          </option>
        ))}
      </select>
      <span style={muted}>Publishing a new version retires the one that is live.</span>
    </label>

    <label>
      File
      <input
        name="document"
        type="file"
        style={field}
        accept={[...LIBRARY_MEDIA_TYPES, ".md", ".txt", ".pdf"].join(",")}
        required
      />
    </label>

    <div>
      <button type="submit" style={button}>
        Upload as a draft
      </button>
    </div>
  </form>
);

const Document = ({ document }: { document: LibraryDocument }): ReactNode => (
  <section style={card}>
    <h3 style={{ margin: "0 0 0.5rem", fontSize: "1.0625rem" }}>{document.title}</h3>
    <table style={table}>
      <thead>
        <tr>
          <th style={cell}>Version date</th>
          <th style={cell}>Status</th>
          <th style={cell}>Sections</th>
          <th style={cell}>Uploaded</th>
          <th style={cell} />
        </tr>
      </thead>
      <tbody>
        {document.versions.map((version) => (
          <Version key={version.id} version={version} />
        ))}
      </tbody>
    </table>
  </section>
);

const Version = ({ version }: { version: LibraryVersion }): ReactNode => (
  <tr>
    <td style={cell}>{version.versionDate}</td>
    <td style={{ ...cell, fontWeight: version.status === "live" ? 600 : 400 }}>
      {STATUS_WORDS[version.status]}
    </td>
    <td style={cell}>
      {version.sectionCount} · ~{version.tokenEstimate.toLocaleString()} tokens
    </td>
    <td style={cell}>{formatWhen(version.uploadedAt)}</td>
    <td style={cell}>
      <Link href={`/library/${version.id}`}>Read the text</Link>
    </td>
  </tr>
);

export default LibraryPage;
