import assert from "node:assert/strict";
import test from "node:test";
import { createPageScopedChunks } from "@/lib/documents/chunker";
import { extractPdfPages } from "@/lib/documents/pdf-extractor";
import { DocumentValidationError, MAX_PDF_BYTES, validatePdfUpload } from "@/lib/documents/validation";

function textPdf(pages: string[]) {
  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`];
  for (let index = 0; index < pages.length; index++) {
    const pageId = 3 + index * 2; const contentId = pageId + 1;
    const escaped = pages[index].replace(/[()\\]/g, "\\$&");
    const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents ${contentId} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let pdf = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Uint8Array(Buffer.from(pdf));
}

test("validates a signed non-empty PDF and rejects unsafe uploads", async () => {
  const valid = new File([textPdf(["Hello document"])], "lecture.pdf", { type: "application/pdf" });
  const result = await validatePdfUpload(valid);
  assert.equal(result.displayName, "lecture.pdf"); assert.match(result.storagePath, /^single-user\/.+\/original\.pdf$/);
  await assert.rejects(() => validatePdfUpload(new File(["text"], "notes.pdf", { type: "application/pdf" })), DocumentValidationError);
  await assert.rejects(() => validatePdfUpload(new File([textPdf(["x"])], "notes.txt", { type: "text/plain" })), DocumentValidationError);
  await assert.rejects(() => validatePdfUpload(new File([], "empty.pdf", { type: "application/pdf" })), DocumentValidationError);
  await assert.rejects(() => validatePdfUpload(new File([new Uint8Array(MAX_PDF_BYTES + 1)], "large.pdf", { type: "application/pdf" })), DocumentValidationError);
});

test("extracts parser-derived one-based physical PDF page numbers", async () => {
  const extracted = await extractPdfPages(textPdf(["First physical page contains extractable lecture text", "Second physical page contains extractable lecture text"]));
  assert.equal(extracted.pageCount, 2);
  assert.deepEqual(extracted.pages.map((page) => page.pageNumber), [1, 2]);
  assert.match(extracted.pages[0].text, /First physical page/);
  assert.match(extracted.pages[1].text, /Second physical page/);
});

test("creates deterministic chunks without crossing page boundaries", () => {
  const pages = [{ pageNumber: 1, text: Array.from({ length: 1200 }, (_, index) => `word${index}`).join(" ") }, { pageNumber: 2, text: "A short second page." }];
  const first = createPageScopedChunks("doc-1", pages, "2026-01-01T00:00:00.000Z");
  const second = createPageScopedChunks("doc-1", pages, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(first, second); assert.ok(first.length >= 3);
  assert.equal(first.at(-1)?.pageNumber, 2); assert.equal(first.at(-1)?.ordinalOnPage, 1);
  assert.ok(first.filter((chunk) => chunk.pageNumber === 1).every((chunk) => chunk.id.includes("_p1_")));
  assert.ok(first[1].text.includes("word680"));
});
