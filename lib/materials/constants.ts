// Week 4, Phase A/B planning-adjacent constants for the materials generators. Deliberately separate
// from lib/learning/constants.ts's versioned LEARNING_CONFIG registry (locked to Week 3's learner-
// intelligence algorithms) and from lib/plan/constants.ts (the planning layer's own bounds) -- these
// are the materials layer's own bounded-output/safety numbers, never a learner-scoring parameter.

// Retrieval tuning for material generation -- the SAME retrieval function (lib/documents/
// retrieval.ts::retrieveDocumentChunks()) quiz generation already uses, just parameterized with a
// slightly larger chunk count so a notes/flashcard set has enough source material to summarize
// or split into several cards. No new retrieval system.
export const MATERIALS_MATCH_COUNT = 6;

// Mirrors LEARNING_CONFIG.SAFETY_CLAMPS.QUIZ_MAX_FIELD_LENGTH's exact bound and rationale: a
// generated text field beyond this length is rejected pre-insert as a validation failure, not
// allowed to blow up storage/UI.
export const MATERIALS_MAX_FIELD_LENGTH = 2000;

export const MATERIALS_MAX_KEY_POINTS = 8;
export const MATERIALS_MAX_TERMS = 8;
export const MATERIALS_MAX_EXAM_FOCUS = 6;

export const MATERIALS_MIN_FLASHCARDS = 3;
export const MATERIALS_MAX_FLASHCARDS = 10;
