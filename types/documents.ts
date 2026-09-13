export const DOCUMENT_STATUSES = [
  "queued", "extracting", "chunking", "embedding", "ready", "failed", "needs_ocr",
] as const;

export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export interface DocumentRecord {
  id: string;
  originalFilename: string;
  displayName: string;
  storagePath: string;
  mimeType: string;
  byteSize: number;
  contentHash: string;
  status: DocumentStatus;
  failureReason: string | null;
  pageCount: number | null;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
  processedAt: string | null;
  embeddingModel: string | null;
  embeddingDimensions: number | null;
}

export interface DocumentChunk {
  id: string;
  documentId: string;
  pageNumber: number;
  ordinalOnPage: number;
  text: string;
  tokenCount: number;
  contentHash: string;
  createdAt: string;
}

export interface ExtractedPage {
  pageNumber: number;
  text: string;
}
