// Teach-Back constants. Retrieval count mirrors lib/materials/constants.ts's own
// MATERIALS_MATCH_COUNT (the same retrieveDocumentChunks() call, just enough chunks to ground an
// evaluation). Field-length bounds are deliberately tighter than notes/flashcards' 2000-char bound:
// every teach-back output field (a strength, a missing idea, a questionable claim, a follow-up
// question) is a short, bullet-style phrase, never a paragraph.

export const TEACH_BACK_MATCH_COUNT = 6;

export const TEACH_BACK_MAX_EXPLANATION_LENGTH = 4000; // the learner's own free-text input bound -- generous (a few paragraphs), never unbounded
export const TEACH_BACK_MAX_FIELD_LENGTH = 600; // each individual strength/missing-idea/questionable-claim/follow-up-question
export const TEACH_BACK_MAX_LIST_ITEMS = 6; // strengths/missingIdeas/questionableClaims, each independently
