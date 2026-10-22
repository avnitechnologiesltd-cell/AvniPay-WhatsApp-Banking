import { dirname } from "node:path";

/**
 * Turning an Administrator's upload into text.
 *
 * **This is the step that fails silently**, and the whole reason publishing is a
 * separate, explicit act. A two-column policy PDF extracts as interleaved
 * nonsense — every line of the left column glued to the line beside it — and
 * nothing here can tell that from a document that reads perfectly. So nothing
 * tries: the extracted text goes back to the Administrator to look at, and the
 * Agent is given it only once a human has said yes.
 *
 * The rule that separates this file from `attachments.ts` on the other side of
 * the deployable: **a Library document is read on purpose and a Customer's
 * attachment is never opened at all.** Same object storage, opposite rule, and
 * the difference is who supplied the bytes — an Administrator, or a Customer.
 */

export type Extraction =
  | { readonly outcome: "extracted"; readonly text: string }
  /** The file is not something this can read, or it is and it would not open. */
  | { readonly outcome: "unreadable"; readonly problem: string };

/**
 * What an Administrator may upload.
 *
 * PDF is here because a Nigerian bank's policy set is PDFs, and a Library that
 * cannot ingest the Bank's actual material is a surface with nothing behind it.
 * Plain text and Markdown are here because they are what a policy looks like
 * once somebody has retyped it, and because they extract exactly.
 */
export const LIBRARY_MEDIA_TYPES = ["application/pdf", "text/plain", "text/markdown"] as const;

export type LibraryMediaType = (typeof LIBRARY_MEDIA_TYPES)[number];

export const isLibraryMediaType = (value: string): value is LibraryMediaType =>
  (LIBRARY_MEDIA_TYPES as readonly string[]).includes(value);

/**
 * A bound on the work one upload can cause, rather than a judgement about how
 * long a policy may be.
 *
 * A PDF is a container format and page count is not a function of file size, so
 * both are capped: the bytes stop a large upload consuming memory, and the pages
 * stop a small malformed one consuming the process. Neither is a limit the Bank
 * will meet with a real document — a hundred-page policy is under a megabyte.
 */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_PAGES = 400;

export const extract = async (
  bytes: Uint8Array,
  mediaType: LibraryMediaType,
): Promise<Extraction> => {
  if (bytes.byteLength === 0) return { outcome: "unreadable", problem: "The file is empty." };
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return {
      outcome: "unreadable",
      problem: `The file is larger than ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))}MB.`,
    };
  }

  const text =
    mediaType === "application/pdf"
      ? await fromPdf(bytes)
      : { outcome: "extracted" as const, text: Buffer.from(bytes).toString("utf8") };

  if (text.outcome === "unreadable") return text;

  const tidied = tidy(text.text);
  return tidied.length === 0
    ? {
        outcome: "unreadable",
        problem: "No text came out of that file. A scanned document is an image, not text.",
      }
    : { outcome: "extracted", text: tidied };
};

/**
 * The slice of PDF.js this file uses, declared rather than imported.
 *
 * The package's own types are not reachable under this workspace's module
 * resolution, and four shapes is less to carry than the resolution change would
 * be. Everything is `unknown` where the library says `any`, so a malformed text
 * item is a value this code checks rather than one it trusts.
 */
interface PdfTextItem {
  readonly str?: unknown;
  readonly hasEOL?: unknown;
}

interface PdfPage {
  getTextContent(): Promise<{ readonly items: readonly PdfTextItem[] }>;
}

interface PdfDocument {
  readonly numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
}

/**
 * `destroy` is the **loading task's**, not the document's, and forgetting that
 * leaks the worker for the life of the process.
 */
interface PdfLoadingTask {
  readonly promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}

interface PdfjsModule {
  getDocument(source: Readonly<Record<string, unknown>>): PdfLoadingTask;
}

let pdfjs: PdfjsModule | undefined;
let standardFontDataUrl: string | undefined;

/**
 * PDF.js, loaded the first time somebody uploads a PDF and not before.
 *
 * `require` rather than `import`, because the package ships ESM only and this
 * deployable compiles to CommonJS. Node loads an ESM graph through `require`
 * from **22.12** onwards, which is why the workspace's `engines` says so rather
 * than `>=22`. Keeping it here keeps the one awkward line in the one file that
 * needs it.
 *
 * The `legacy` build is the one Mozilla publishes for Node — the default build
 * reaches for `DOMMatrix` and throws on load outside a browser, with a message
 * that names neither this file nor the fix.
 */
const loadPdfjs = (): PdfjsModule => {
  if (!pdfjs) {
    pdfjs = require("pdfjs-dist/legacy/build/pdf.mjs") as PdfjsModule;
    standardFontDataUrl = `${dirname(require.resolve("pdfjs-dist/package.json"))}/standard_fonts/`;
  }
  return pdfjs;
};

const fromPdf = async (bytes: Uint8Array): Promise<Extraction> => {
  let task: PdfLoadingTask | undefined;
  try {
    task = loadPdfjs().getDocument({
      // A copy, because pdf.js transfers ownership of the buffer it is handed
      // and the caller still wants the bytes to put in object storage.
      data: new Uint8Array(bytes),
      // **A PDF is a document the Bank supplied, not a program.** Both of these
      // are off by default in recent releases and are named anyway, because the
      // one thing that must never become true is that opening a file to read it
      // also runs something inside it.
      isEvalSupported: false,
      useSystemFonts: false,
      standardFontDataUrl,
    });

    const document = await task.promise;

    if (document.numPages > MAX_PAGES) {
      return {
        outcome: "unreadable",
        problem: `That document has ${document.numPages} pages. The limit is ${MAX_PAGES}.`,
      };
    }

    const pages: string[] = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      pages.push(
        content.items
          .map((item) =>
            typeof item.str === "string" ? `${item.str}${item.hasEOL === true ? "\n" : ""}` : "",
          )
          .join(""),
      );
    }

    // A page break is a paragraph break and nothing more. It is deliberately not
    // a section boundary: a policy clause that runs over a page is one clause,
    // and citing half of it would be worse than citing none.
    return { outcome: "extracted", text: pages.join("\n\n") };
  } catch (error) {
    return {
      outcome: "unreadable",
      problem: `That PDF could not be read: ${error instanceof Error ? error.message : "unknown error"}.`,
    };
  } finally {
    await task?.destroy().catch(() => undefined);
  }
};

/**
 * Normalises whitespace without touching words.
 *
 * Three runs of blank lines become one, trailing spaces go, and `\r\n` becomes
 * `\n` — all of which the section splitter downstream depends on. Nothing here
 * rewrites the Bank's prose, because the text an Administrator approves has to
 * be the text the Agent is given.
 */
const tidy = (text: string): string =>
  text
    .replace(/\r\n?/g, "\n")
    // A soft hyphen, a zero-width space and a byte-order mark all survive PDF
    // extraction, and each breaks an exact-term match on the one thing lexical
    // search is good at. **Written as escapes**: the literal characters are
    // invisible in an editor and in a diff, so a future reader would have no way
    // to know what this line removes.
    .replace(/[\u00ad\u200b\ufeff]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, "").replace(/[ \t]{2,}/g, " "))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
