// Week 4, Phase A/B -- AI study materials (grounded notes + flashcards). Client-safe: no server-only
// import, mirroring the exact "server decides, frontend displays" split types/progress.ts and
// types/plan.ts already established. Citations reuse types/progress.ts's existing QuizCitation shape
// verbatim (citationId/documentId/chunkId/filename/pageNumber) -- never a second, incompatible
// citation type for materials.

import type { QuizCitation } from "@/types/progress";

export interface MaterialTerm {
  term: string;
  definition: string;
}

export interface GeneratedNotes {
  title: string;
  conceptId: string;
  conceptKey: string;
  conceptDisplayName: string;
  summary: string;
  keyPoints: string[];
  importantTerms: MaterialTerm[];
  examFocus: string[];
  citations: QuizCitation[];
  generatedAt: string;
}

export interface Flashcard {
  front: string;
  back: string;
  citations: QuizCitation[];
}

export interface GeneratedFlashcardSet {
  conceptId: string;
  conceptKey: string;
  conceptDisplayName: string;
  cards: Flashcard[];
  generatedAt: string;
}

// The client supplies only an identifier + document scope -- never a concept's mastery/priority/
// difficulty, matching lib/quiz/generate.ts's own QuizGenerationRequest boundary (Step 4: client
// input is never authoritative for anything beyond "which concept, from which documents").
export interface MaterialGenerationRequest {
  conceptKey: string;
  documentIds: string[];
}

export type NotesGenerationResult =
  | { status: "generated"; notes: GeneratedNotes }
  | { status: "insufficient_evidence" }
  | { status: "generation_failed"; reason: string };

export type FlashcardsGenerationResult =
  | { status: "generated"; flashcards: GeneratedFlashcardSet }
  | { status: "insufficient_evidence" }
  | { status: "generation_failed"; reason: string };
