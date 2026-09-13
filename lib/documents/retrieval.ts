import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { embedQuery } from "@/lib/documents/embeddings";

export type RetrievalMatch = { chunkId: string; documentId: string; filename: string; pageNumber: number; ordinalOnPage: number; text: string; similarity: number };
export type RetrievalResult = { status: "sufficient" | "insufficient"; matches: RetrievalMatch[] };
const threshold = () => Number(process.env.RAG_MATCH_THRESHOLD ?? "0.55");
const count = () => Math.min(Math.max(Number(process.env.RAG_MATCH_COUNT ?? "5"), 1), 10);

export function validateRetrievalRow(row: unknown): RetrievalMatch | null {
  if (!row || typeof row !== "object") return null;
  const value = row as Record<string, unknown>;
  if (typeof value.chunk_id !== "string" || typeof value.document_id !== "string" || typeof value.filename !== "string" || typeof value.page_number !== "number" || !Number.isInteger(value.page_number) || value.page_number < 1 || typeof value.ordinal_on_page !== "number" || !Number.isInteger(value.ordinal_on_page) || value.ordinal_on_page < 1 || typeof value.text !== "string" || typeof value.similarity !== "number" || !Number.isFinite(value.similarity)) return null;
  return { chunkId: value.chunk_id, documentId: value.document_id, filename: value.filename, pageNumber: value.page_number, ordinalOnPage: value.ordinal_on_page, text: value.text, similarity: value.similarity };
}

export async function retrieveDocumentChunks(question: string, selectedDocumentIds: string[], matchCount = count(), matchThreshold = threshold(), dependencies?: { supabase?: ReturnType<typeof getSupabaseAdmin>; embed?: (question: string) => Promise<number[]> }): Promise<RetrievalResult> {
  if (!Array.isArray(selectedDocumentIds) || selectedDocumentIds.length === 0) throw new Error("Select at least one ready document.");
  if (!question.trim()) throw new Error("Enter a question before retrieving documents.");
  const supabase = dependencies?.supabase ?? getSupabaseAdmin();
  const { data: documents, error: documentsError } = await supabase.from("documents").select("id,status").in("id", selectedDocumentIds);
  if (documentsError || !documents || documents.length !== selectedDocumentIds.length || documents.some((document) => document.status !== "ready")) throw new Error("Selected documents must exist and be ready.");
  const { data, error } = await supabase.rpc("match_document_chunks", { query_embedding: await (dependencies?.embed ?? embedQuery)(question), selected_document_ids: selectedDocumentIds, match_threshold: matchThreshold, match_count: matchCount });
  if (error) throw new Error("Semantic retrieval failed.");
  const matches = ((data ?? []) as unknown[]).map(validateRetrievalRow).filter((row): row is RetrievalMatch => row !== null);
  return { status: matches.length ? "sufficient" : "insufficient", matches };
}
