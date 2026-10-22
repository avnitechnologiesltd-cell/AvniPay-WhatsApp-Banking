import { describe, expect, it } from "vitest";

import { extract, isLibraryMediaType } from "./extraction";

/**
 * A minimal single-page PDF, written by hand.
 *
 * Not a fixture file, because the thing under test is *the bytes of a PDF go in
 * and text comes out* — and a checked-in binary is a thing a reader has to take
 * on trust. This is a PDF a reader can verify by reading it.
 */
const onePagePdf = (lines: readonly string[]): Uint8Array => {
  const content = lines
    .map((line, index) => `BT /F1 12 Tf 72 ${720 - index * 20} Td (${line}) Tj ET`)
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

describe("extracting the text of an uploaded document", () => {
  it("reads a PDF, which is what a bank's policy set actually is", async () => {
    const result = await extract(
      onePagePdf(["Transfer Charges", "The NIP fee is published by NIBSS."]),
      "application/pdf",
    );

    expect(result.outcome).toBe("extracted");
    expect(result.outcome === "extracted" && result.text).toContain("Transfer Charges");
    expect(result.outcome === "extracted" && result.text).toContain("published by NIBSS");
  });

  it("reads plain text and Markdown exactly", async () => {
    const source = "# Charges\n\nThe fee is published.";
    const result = await extract(new Uint8Array(Buffer.from(source, "utf8")), "text/markdown");

    expect(result).toEqual({ outcome: "extracted", text: source });
  });

  it("says a scanned document has no text in it, rather than publishing nothing", async () => {
    // A scan is an image. Without this the Administrator publishes a document
    // with zero sections and it is silently unretrievable forever.
    const result = await extract(onePagePdf([]), "application/pdf");

    expect(result).toEqual({
      outcome: "unreadable",
      problem: "No text came out of that file. A scanned document is an image, not text.",
    });
  });

  it("refuses a file that is not a PDF pretending to be one", async () => {
    const result = await extract(
      new Uint8Array(Buffer.from("this is not a pdf", "utf8")),
      "application/pdf",
    );

    expect(result.outcome).toBe("unreadable");
  });

  it("refuses an empty file", async () => {
    expect(await extract(new Uint8Array(), "text/plain")).toEqual({
      outcome: "unreadable",
      problem: "The file is empty.",
    });
  });

  it("names the three media types the Library takes", () => {
    expect(isLibraryMediaType("application/pdf")).toBe(true);
    expect(isLibraryMediaType("text/markdown")).toBe(true);
    expect(isLibraryMediaType("text/plain")).toBe(true);
    // A Word document is not one of them, and an Administrator is told so at
    // upload rather than discovering an empty preview.
    expect(isLibraryMediaType("application/msword")).toBe(false);
    expect(isLibraryMediaType("image/png")).toBe(false);
  });

  it("normalises the whitespace a PDF leaves behind without rewriting the prose", async () => {
    const source = "Charges\r\n\r\n\r\n\r\nThe  fee   is published.   \n";
    const result = await extract(new Uint8Array(Buffer.from(source, "utf8")), "text/plain");

    expect(result).toEqual({ outcome: "extracted", text: "Charges\n\nThe fee is published." });
  });
});
