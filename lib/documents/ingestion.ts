import "server-only";
import type { DocumentRecord, ExtractedPage } from "@/types/documents";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { createPageScopedChunks } from "@/lib/documents/chunker";
import { PdfExtractionError, extractPdfPages } from "@/lib/documents/pdf-extractor";
import { removePrivatePdf, storePrivatePdf } from "@/lib/documents/storage";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, embedDocumentChunks } from "@/lib/documents/embeddings";

type ValidatedPdf = { id: string; bytes: Uint8Array; originalFilename: string; displayName: string; contentHash: string; storagePath: string };

// Small seams so failure-path tests can drive ingestion deterministically without real Supabase, storage, or Gemini calls.
// Production behaviour is unchanged: every dependency defaults to the real implementation.
export type IngestionDependencies = {
  supabase?: ReturnType<typeof getSupabaseAdmin>;
  storePdf?: (path: string, bytes: Uint8Array) => Promise<void>;
  removePdf?: (path: string) => Promise<void>;
  extractPages?: (bytes: Uint8Array) => Promise<{ pageCount: number; pages: ExtractedPage[] }>;
  embedChunks?: (texts: string[]) => Promise<number[][]>;
};
const toRow = (row: Record<string, unknown>): DocumentRecord => ({
  id: row.id as string, originalFilename: row.original_filename as string, displayName: row.display_name as string, storagePath: row.storage_path as string, mimeType: row.mime_type as string, byteSize: row.byte_size as number, contentHash: row.content_hash as string, status: row.status as DocumentRecord["status"], failureReason: row.failure_reason as string | null, pageCount: row.page_count as number | null, chunkCount: row.chunk_count as number, createdAt: row.created_at as string, updatedAt: row.updated_at as string, processedAt: row.processed_at as string | null, embeddingModel: row.embedding_model as string | null, embeddingDimensions: row.embedding_dimensions as number | null,
});

export async function ingestPdf(file: ValidatedPdf, dependencies: IngestionDependencies = {}): Promise<DocumentRecord> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const storePdf = dependencies.storePdf ?? storePrivatePdf;
  const removePdf = dependencies.removePdf ?? removePrivatePdf;
  const extractPages = dependencies.extractPages ?? extractPdfPages;
  const embedChunks = dependencies.embedChunks ?? embedDocumentChunks;
  const base = { id: file.id, original_filename: file.originalFilename, display_name: file.displayName, storage_path: file.storagePath, mime_type: "application/pdf", byte_size: file.bytes.byteLength, content_hash: file.contentHash, status: "queued", chunk_count: 0 };
  const { error: insertError } = await supabase.from("documents").insert(base);
  if (insertError) throw new Error("Could not create document metadata.");
  let stored = false;
  let chunksPersisted = false;
  try {
    await storePdf(file.storagePath, file.bytes);
    stored = true;
    await supabase.from("documents").update({ status: "extracting" }).eq("id", file.id);
    const extracted = await extractPages(file.bytes);
    await supabase.from("documents").update({ status: "chunking", page_count: extracted.pageCount }).eq("id", file.id);
    const chunks = createPageScopedChunks(file.id, extracted.pages);
    const { error: chunkError } = await supabase.from("document_chunks").insert(chunks.map((chunk) => ({ id: chunk.id, document_id: chunk.documentId, page_number: chunk.pageNumber, ordinal_on_page: chunk.ordinalOnPage, text: chunk.text, token_count: chunk.tokenCount, content_hash: chunk.contentHash, created_at: chunk.createdAt })));
    if (chunkError) throw new Error("Could not save extracted document chunks.");
    chunksPersisted = true;
    await supabase.from("documents").update({ status: "embedding", chunk_count: chunks.length, failure_reason: null }).eq("id", file.id);
    const vectors = await embedChunks(chunks.map((chunk) => chunk.text));
    if (vectors.length !== chunks.length) throw new Error("Embedding count did not match document chunks.");
    for (let index = 0; index < chunks.length; index++) {
      const { error: vectorError } = await supabase.from("document_chunks").update({ embedding: vectors[index] }).eq("id", chunks[index].id).eq("document_id", file.id);
      if (vectorError) throw new Error("Could not persist a document embedding.");
    }
    const { count, error: vectorCountError } = await supabase.from("document_chunks").select("id", { count: "exact", head: true }).eq("document_id", file.id).not("embedding", "is", null);
    if (vectorCountError || count !== chunks.length) throw new Error("Not every document chunk received an embedding.");
    const { data, error } = await supabase.from("documents").update({ status: "ready", chunk_count: chunks.length, embedding_model: EMBEDDING_MODEL, embedding_dimensions: EMBEDDING_DIMENSIONS, processed_at: new Date().toISOString(), failure_reason: null }).eq("id", file.id).select().single();
    if (error || !data) throw new Error("Could not finish document ingestion.");
    return toRow(data);
  } catch (error) {
    const needsOcr = error instanceof PdfExtractionError && error.needsOcr;
    const reason = error instanceof PdfExtractionError ? error.message : "Document processing failed. Please try another text-based PDF.";
    if (!chunksPersisted) await supabase.from("document_chunks").delete().eq("document_id", file.id);
    await supabase.from("documents").update({ status: needsOcr ? "needs_ocr" : "failed", failure_reason: reason, chunk_count: chunksPersisted ? undefined : 0 }).eq("id", file.id);
    if (!needsOcr && stored && !chunksPersisted) { try { await removePdf(file.storagePath); } catch { /* metadata retains an actionable failure state */ } }
    const { data } = await supabase.from("documents").select().eq("id", file.id).single();
    if (data) return toRow(data);
    throw error;
  }
}

export async function listDocuments(): Promise<DocumentRecord[]> {
  const { data, error } = await getSupabaseAdmin().from("documents").select().order("created_at", { ascending: false });
  if (error) throw new Error("Could not load documents.");
  return (data ?? []).map(toRow);
}

export async function deleteDocument(id: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("documents").select("storage_path").eq("id", id).single();
  if (error || !data) return false;
  await removePrivatePdf(data.storage_path);
  const { error: deleteError } = await supabase.from("documents").delete().eq("id", id);
  if (deleteError) throw new Error("PDF removed, but document metadata could not be deleted.");
  return true;
}
