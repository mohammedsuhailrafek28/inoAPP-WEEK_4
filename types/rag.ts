import type { ExplanationMode, ExamMarks, ChatMessage } from "@/types/chat";

// A grounded answer is either backed by retrieved evidence ("grounded") or the
// selected documents did not contain enough relevant material ("insufficient").
export type GroundingStatus = "grounded" | "insufficient";

// Server-owned evidence returned by Phase 2 retrieval. `text` is untrusted
// document content; embeddings are never represented here or sent to the client.
export interface RetrievedEvidence {
  chunkId: string;
  documentId: string;
  filename: string;
  pageNumber: number;
  ordinalOnPage: number;
  text: string;
  similarity: number;
}

// Retrieved evidence paired with the stable, prompt-facing label the model is
// allowed to reference (e.g. "S1"). The label -> metadata mapping is owned by
// the server and can never be altered by model output.
export interface LabeledEvidence {
  label: string;
  evidence: RetrievedEvidence;
}

// Authoritative citation. Every field is copied from server-owned retrieval
// metadata, never from generated text.
export interface Citation {
  citationId: string;
  documentId: string;
  chunkId: string;
  filename: string;
  pageNumber: number;
}

export interface GroundedAnswer {
  status: GroundingStatus;
  answer: string;
  citations: Citation[];
  // Non-sensitive evidence metadata (no embeddings, no raw similarity math the
  // client needs). Present for grounded answers so the UI can show context.
  evidence: Array<Pick<RetrievedEvidence, "chunkId" | "documentId" | "filename" | "pageNumber"> & { label: string }>;
}

export type RagMode = ExplanationMode;

export interface RagRequest {
  question: string;
  documentIds: string[];
  mode: RagMode;
  marks?: ExamMarks;
  history?: ChatMessage[];
  // ARCHITECTURE.md §21/§22, Phase 10 -- an OPTIONAL, explicit canonical concept key the
  // trusted application flow (or the client) may supply to enable personalization for this turn.
  // Never fuzzy-created or LLM-inferred from the question text (Step 5); an unknown/omitted key
  // simply means no personalization is computed this turn (Step 27's mandatory fallback) -- normal
  // Week 2 grounded RAG is entirely unaffected either way.
  conceptKey?: string;
}

// Shape the generation layer must return (after parsing / validation).
export interface RagGenerationOutput {
  answer: string;
  usedSources: string[];
}
