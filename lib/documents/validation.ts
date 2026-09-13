import { createHash, randomUUID } from "node:crypto";

export const MAX_PDF_BYTES = 20 * 1024 * 1024;

export class DocumentValidationError extends Error {}

export function safeDisplayFilename(filename: string): string {
  const base = filename.replace(/^.*[\\/]/, "").replace(/[\u0000-\u001f<>:"/\\|?*]/g, " ").trim();
  const compact = base.replace(/\s+/g, " ");
  return (compact || "document.pdf").slice(0, 180);
}

export async function validatePdfUpload(file: File) {
  if (!file || file.size === 0) throw new DocumentValidationError("Choose a non-empty PDF file.");
  if (file.size > MAX_PDF_BYTES) throw new DocumentValidationError("PDF files must be 20 MB or smaller.");
  if (file.type !== "application/pdf") throw new DocumentValidationError("Only PDF files are supported.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length < 5 || new TextDecoder("ascii").decode(bytes.subarray(0, 5)) !== "%PDF-") {
    throw new DocumentValidationError("This file is not a valid PDF.");
  }
  const id = randomUUID();
  return {
    id,
    bytes,
    originalFilename: safeDisplayFilename(file.name),
    displayName: safeDisplayFilename(file.name),
    contentHash: createHash("sha256").update(bytes).digest("hex"),
    storagePath: `single-user/${id}/original.pdf`,
  };
}
