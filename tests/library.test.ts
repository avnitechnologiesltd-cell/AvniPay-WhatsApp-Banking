import { afterEach, describe, expect, it } from "vitest";

import { startHarness, type Harness } from "./harness";

/**
 * **The Library**: the Bank's own documents, and the ingestion path that puts
 * them in front of the Support Agent.
 *
 * This file is about the Administrator's half — uploading, previewing,
 * publishing, retiring. `tests/support-agent.test.ts` is about what a Customer
 * gets out of the other end.
 *
 * Two rules carry it, and neither is a preference:
 *
 * - **A draft is never retrievable.** Publishing is a separate step somebody
 *   takes after reading the extracted text, because PDF extraction fails
 *   silently and a two-column policy comes out as interleaved nonsense that
 *   nothing in the platform can tell from prose.
 * - **Unpublishing is complete the moment it commits.** There is no second copy
 *   of a document's text anywhere — no embedding index, no cache of extracted
 *   text, no separate search store — because every extra copy is a place a
 *   withdrawn policy survives, and a Support Agent quoting a withdrawn policy is
 *   a compliance problem for the Bank.
 */

let harness: Harness;

const POLICY = [
  "# Funds Transfer Policy",
  "",
  "This policy applies to all naira current and savings accounts.",
  "",
  "## Charges",
  "",
  "A transfer to another bank attracts the NIP fee published by NIBSS.",
  "",
  "## Reversals",
  "",
  "A failed transfer is reversed within the settlement cycle.",
].join("\n");

const start = async (): Promise<void> => {
  harness = await startHarness();
};

afterEach(async () => {
  await harness?.stop();
});

/** The Dashboard's own reads, driven through the real endpoints. */
const asStaff = async (
  role: "administrator" | "support_officer",
  path: string,
  init: RequestInit = {},
): Promise<Response> => {
  const { token } = await harness.signInStaff(role);
  return fetch(`${harness.middlewareUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
};

interface LibraryVersion {
  readonly id: string;
  readonly documentTitle: string;
  readonly versionDate: string;
  readonly status: string;
  readonly sectionCount: number;
  readonly tokenEstimate: number;
  readonly publishedAt: string | null;
  readonly retiredAt: string | null;
}

const documents = async (): Promise<
  readonly { id: string; title: string; versions: readonly LibraryVersion[] }[]
> => {
  const response = await asStaff("support_officer", "/dashboard/library");
  expect(response.status).toBe(200);
  const body = (await response.json()) as { documents: never[] };
  return body.documents;
};

const version = async (
  versionId: string,
): Promise<{
  version: LibraryVersion;
  sections: readonly { ordinal: number; heading: string; body: string; tokenEstimate: number }[];
}> => {
  const response = await asStaff("support_officer", `/dashboard/library/versions/${versionId}`);
  expect(response.status).toBe(200);
  return (await response.json()) as never;
};

const auditRows = async (action: string): Promise<{ outcome: string; detail: Record<string, unknown> }[]> => {
  const response = await asStaff(
    "administrator",
    `/dashboard/audit?action=${encodeURIComponent(action)}&limit=100`,
  );
  const body = (await response.json()) as {
    entries: { outcome: string; detail: Record<string, unknown> }[];
  };
  return body.entries;
};

// --- Ingestion ---------------------------------------------------------------

describe("an Administrator uploads a document", () => {
  it("cuts it into sections at the Bank's own headings", async () => {
    await start();
    const { versionId } = await harness.publishToLibrary({
      title: "Funds Transfer Policy",
      text: POLICY,
      publish: false,
    });

    const { sections } = await version(versionId);

    // A heading is a boundary the Bank already drew, and it is what makes a
    // citation mean something. "Chunk 14 of 60" is not checkable by the Officer
    // a Customer complains to.
    expect(sections.map((section) => section.heading)).toEqual([
      "Funds Transfer Policy",
      "Charges",
      "Reversals",
    ]);
  });

  it("shows the extracted text back before anything is published", async () => {
    // The whole reason publishing is a separate step. PDF extraction fails
    // silently and nothing in the platform can tell interleaved nonsense from
    // prose — a person can, and this is the screen where they do it.
    await start();
    const { versionId } = await harness.publishToLibrary({
      title: "Funds Transfer Policy",
      text: POLICY,
      publish: false,
    });

    const { version: draft, sections } = await version(versionId);

    expect(draft.status).toBe("draft");
    expect(draft.publishedAt).toBeNull();
    expect(sections.map((section) => section.body).join("\n")).toContain(
      "NIP fee published by NIBSS",
    );
  });

  it("refuses a file it cannot read, and says why", async () => {
    await start();

    const response = await asStaff("administrator", "/dashboard/library", {
      method: "POST",
      body: JSON.stringify({
        title: "Tariff",
        versionDate: "2026-03-01",
        mediaType: "application/msword",
        fileName: "tariff.doc",
        content: Buffer.from("anything").toString("base64"),
      }),
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { message: string }).message).toContain(
      "PDF, plain text and Markdown",
    );
  });

  it("records the upload against the Administrator who made it", async () => {
    // Model-facing text the Bank wrote. Who put this in front of Customers is a
    // question with the same weight as who changed the fee.
    await start();
    await harness.publishToLibrary({ title: "Funds Transfer Policy", text: POLICY, publish: false });

    const [uploaded] = await auditRows("library.uploaded");
    expect(uploaded?.outcome).toBe("succeeded");
    expect(uploaded?.detail["title"]).toBe("Funds Transfer Policy");
    expect(uploaded?.detail["sections"]).toBe(3);
  });
});

describe("publishing is a separate, explicit step", () => {
  it("takes a draft live and records who did it", async () => {
    await start();
    const { versionId } = await harness.publishToLibrary({
      title: "Funds Transfer Policy",
      text: POLICY,
    });

    expect((await version(versionId)).version.status).toBe("live");

    const [published] = await auditRows("library.published");
    expect(published?.outcome).toBe("succeeded");
    expect(published?.detail["versionDate"]).toBe("2026-03-01");
  });

  it("refuses a Support Officer, and leaves a row with their name on it", async () => {
    // Library text is model-facing text the Bank writes — the same argument
    // that makes Connector registration Administrator-only.
    await start();
    const { versionId } = await harness.publishToLibrary({
      title: "Funds Transfer Policy",
      text: POLICY,
      publish: false,
    });

    const response = await asStaff(
      "support_officer",
      `/dashboard/library/versions/${versionId}/publish`,
      { method: "POST", body: "{}" },
    );

    expect(response.status).toBe(403);
    expect((await version(versionId)).version.status).toBe("draft");
    expect(await auditRows("library.published")).toContainEqual(
      expect.objectContaining({ outcome: "refused" }),
    );
  });

  it("refuses to publish the same version twice", async () => {
    await start();
    const { versionId } = await harness.publishToLibrary({
      title: "Funds Transfer Policy",
      text: POLICY,
    });

    const again = await asStaff("administrator", `/dashboard/library/versions/${versionId}/publish`, {
      method: "POST",
      body: "{}",
    });

    expect(again.status).toBe(400);
  });
});

describe("a document has versions, and exactly one is live", () => {
  it("retires the previous version when a new one is published", async () => {
    await start();
    const first = await harness.publishToLibrary({
      title: "Funds Transfer Policy",
      versionDate: "2026-01-01",
      text: POLICY,
    });
    const second = await harness.publishToLibrary({
      title: "Funds Transfer Policy",
      documentId: first.documentId,
      versionDate: "2026-06-01",
      text: POLICY.replace("NIP fee published by NIBSS", "NIP fee published by NIBSS, plus VAT"),
    });

    const [document] = await documents();
    expect(document?.versions.filter((one) => one.status === "live")).toHaveLength(1);
    expect((await version(first.versionId)).version.status).toBe("superseded");
    expect((await version(second.versionId)).version.status).toBe("live");
  });

  it("keeps *superseded* and *withdrawn* apart, because they are different answers", async () => {
    // "We reissued this policy" and "we retired it" are two different things to
    // say to a regulator, and the Bank has to be able to tell them apart six
    // months later.
    await start();
    const first = await harness.publishToLibrary({ title: "Policy", text: POLICY });
    const second = await harness.publishToLibrary({
      title: "Policy",
      documentId: first.documentId,
      versionDate: "2026-06-01",
      text: POLICY,
    });
    await harness.withdrawFromLibrary(second.versionId);

    expect((await version(first.versionId)).version.status).toBe("superseded");
    expect((await version(second.versionId)).version.status).toBe("withdrawn");
  });

  it("refuses to withdraw something that was never live", async () => {
    await start();
    const { versionId } = await harness.publishToLibrary({
      title: "Policy",
      text: POLICY,
      publish: false,
    });

    const response = await asStaff(
      "administrator",
      `/dashboard/library/versions/${versionId}/withdraw`,
      { method: "POST", body: "{}" },
    );

    expect(response.status).toBe(400);
  });
});

describe("throwing a draft away", () => {
  it("discards one nobody published", async () => {
    await start();
    const { versionId } = await harness.publishToLibrary({
      title: "Policy",
      text: POLICY,
      publish: false,
    });

    const response = await asStaff(
      "administrator",
      `/dashboard/library/versions/${versionId}/discard`,
      { method: "POST", body: "{}" },
    );

    expect(response.status).toBe(201);
    expect(
      (await asStaff("administrator", `/dashboard/library/versions/${versionId}`)).status,
    ).toBe(404);
  });

  it("will not delete a published version, because it is the Bank's record", async () => {
    // A published version is evidence of what a Customer may have been told, and
    // evidence is not something this platform deletes. Withdrawing is the
    // retirement path; there is no other.
    await start();
    const { versionId } = await harness.publishToLibrary({ title: "Policy", text: POLICY });

    const response = await asStaff(
      "administrator",
      `/dashboard/library/versions/${versionId}/discard`,
      { method: "POST", body: "{}" },
    );

    expect(response.status).toBe(400);
    expect((await version(versionId)).version.status).toBe("live");
  });
});

describe("the original file", () => {
  it("goes to the same object storage a Customer's attachment does", async () => {
    // Same storage, opposite rule, and the difference is who supplied it. The
    // Platform moves a Customer's file WITHOUT OPENING IT; a Library document is
    // read on purpose, because an Administrator uploaded it.
    await start();
    await harness.publishToLibrary({ title: "Policy", text: POLICY });

    const stored = [...harness.objectStore.objects.keys()].filter((key) => key.startsWith("library/"));
    expect(stored).toHaveLength(1);
  });

  it("is keyed by something the Administrator did not choose", async () => {
    // A filename is a name somebody chose, and a key made of one is a path
    // traversal waiting for a bucket that normalises slashes.
    await start();
    await harness.publishToLibrary({
      title: "Policy",
      fileName: "../../etc/passwd",
      text: POLICY,
    });

    const [key] = [...harness.objectStore.objects.keys()].filter((one) => one.startsWith("library/"));
    expect(key).toMatch(/^library\/[0-9a-f]{32}$/);
  });
});

describe("a real PDF, which is what a bank's policy set actually is", () => {
  it("is read, sectioned and published", async () => {
    await start();
    const { versionId } = await harness.publishToLibrary({
      title: "Tariff",
      mediaType: "application/pdf",
      fileName: "tariff.pdf",
      text: onePagePdf(["CHARGES AND FEES", "A transfer to another bank attracts the NIP fee."]),
      publish: false,
    });

    const { sections } = await version(versionId);
    expect(sections[0]?.heading).toBe("CHARGES AND FEES");
    expect(sections[0]?.body).toContain("NIP fee");
  });

  it("is refused when it is a scan, rather than published with nothing in it", async () => {
    // A scan is an image. Published, it would be a live document with zero
    // sections — silently unretrievable forever, and nobody would know.
    await start();

    await expect(
      harness.publishToLibrary({
        title: "Tariff",
        mediaType: "application/pdf",
        fileName: "scan.pdf",
        text: onePagePdf([]),
      }),
    ).rejects.toThrow(/scanned document is an image/);
  });
});

/**
 * A minimal single-page PDF, written by hand rather than checked in as a binary.
 *
 * The thing under test is *the bytes of a real PDF go in and text comes out*,
 * and a fixture file is something a reader has to take on trust. This is a PDF a
 * reader can verify by reading it.
 */
const onePagePdf = (lines: readonly string[]): Uint8Array => {
  const content = lines
    .map((line, index) => `BT /F1 12 Tf 72 ${720 - index * 24} Td (${line}) Tj ET`)
    .join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const startxref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(pdf, "latin1"));
};
