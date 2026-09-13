export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  // Present only on document-grounded assistant replies (Phase 3 RAG).
  citations?: MessageCitation[];
  groundingStatus?: "grounded" | "insufficient";
  // Bounded, server-derived personalization metadata (ARCHITECTURE.md §21/§25, Phase 10/12)
  // -- present only when the server actually personalized this turn. Never raw learner-state
  // numbers; see types/progress.ts::PersonalizationMetadata for the full shape.
  personalization?: {
    personalizationApplied: boolean;
    targetConceptKey: string | null;
    pedagogicalAction: string | null;
    difficulty: string | null;
    scaffoldingLevel: string | null;
    reasonCodes: string[] | null;
  };
};

// Compact, display-only citation. Mirrors the authoritative server Citation but
// carries just what the UI renders.
export type MessageCitation = {
  citationId: string;
  filename: string;
  pageNumber: number;
};

export type ExplanationMode = "simple" | "detailed" | "exam";

export type ExamMarks = 2 | 5 | 10 | 16;

export interface ChatRequest {
  message: string;
  mode: ExplanationMode;
  history: ChatMessage[];
  marks?: ExamMarks;
}

export interface ChatResponse {
  content: string;
}

export interface ChatErrorResponse {
  error: string;
}
