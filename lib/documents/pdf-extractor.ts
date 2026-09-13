import type { ExtractedPage } from "@/types/documents";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export class PdfExtractionError extends Error {
  constructor(message: string, public readonly needsOcr = false) { super(message); }
}

function normalizePageText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export async function extractPdfPages(bytes: Uint8Array): Promise<{ pageCount: number; pages: ExtractedPage[] }> {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
      join(process.cwd(), "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.mjs")
    ).toString();
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), stopAtErrors: true });
    const pdf = await task.promise;
    const pages: ExtractedPage[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        text += item.str;
        if (item.hasEOL) text += "\n";
        else text += " ";
      }
      pages.push({ pageNumber, text: normalizePageText(text) });
    }
    pdf.cleanup();
    if (!pages.some((page) => page.text.replace(/\s/g, "").length >= 20)) {
      throw new PdfExtractionError("No selectable text was found. This PDF may require OCR.", true);
    }
    return { pageCount: pdf.numPages, pages };
  } catch (error) {
    if (error instanceof PdfExtractionError) throw error;
    console.error("PDF extraction failed:", error);
    const message = error instanceof Error ? error.message : "Unable to read this PDF.";
    if (/password|encrypted/i.test(message)) throw new PdfExtractionError("Password-protected PDFs are not supported.");
    throw new PdfExtractionError("This PDF could not be read. Upload a valid text-based PDF.");
  }
}
