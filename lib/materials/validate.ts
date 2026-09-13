// Materials generation validation gates (Week 4, Phase A/B). Architectural precedent:
// lib/quiz/validate.ts -- pure, side-effect-free, takes the raw generated candidate + already-
// resolved trusted context (labeled retrieval evidence, the request's own document scope), returns
// accept/reject. Never calls Gemini, Supabase, or any I/O.

import { assignEvidenceLabels, buildCitations } from "@/lib/documents/citations";
import { MATERIALS_MAX_EXAM_FOCUS, MATERIALS_MAX_FIELD_LENGTH, MATERIALS_MAX_FLASHCARDS, MATERIALS_MAX_KEY_POINTS, MATERIALS_MAX_TERMS, MATERIALS_MIN_FLASHCARDS } from "@/lib/materials/constants";
import type { Flashcard, MaterialTerm } from "@/types/materials";
import type { QuizCitation } from "@/types/progress";

// Mirrors lib/quiz/validate.ts's own INJECTION_PATTERNS list exactly -- the same defense (retrieved
// document text is untrusted; a generated field echoing an instruction-injection pattern is strong
// evidence the source text steered generation, so the affected content is rejected/dropped, never
// partially trusted) applied to notes/flashcard output instead of quiz questions.
const INJECTION_PATTERNS = [/ignore (all |previous |the )?instructions/i, /you are now/i, /system\s*:/i, /reveal (the |your )?(prompt|system|instructions)/i, /disregard (all |previous |the )?/i, /act as (if )?/i];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOversized(...fields: (string | undefined)[]): boolean {
  return fields.some((f) => typeof f === "string" && f.length > MATERIALS_MAX_FIELD_LENGTH);
}

function hasSuspiciousText(...fields: (string | undefined)[]): boolean {
  return fields.some((f) => typeof f === "string" && INJECTION_PATTERNS.some((pattern) => pattern.test(f)));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

export interface MaterialValidationContext {
  candidate: unknown; // raw, untrusted parsed JSON from Gemini
  labeledEvidence: ReturnType<typeof assignEvidenceLabels>;
  selectedDocumentIds: string[]; // citations must stay inside the request's own document scope
}

// --- Notes ---------------------------------------------------------------------------------------

export type NotesValidationRejectionReason = "MALFORMED_OUTPUT" | "OVERSIZED_FIELD" | "SUSPICIOUS_INSTRUCTION_FOLLOWING" | "MISSING_SOURCE_SUPPORT";

export interface ValidatedNotesContent {
  title: string;
  summary: string;
  keyPoints: string[];
  importantTerms: MaterialTerm[];
  examFocus: string[];
}

export interface NotesValidationResult {
  valid: boolean;
  reason: NotesValidationRejectionReason | null;
  content: ValidatedNotesContent | null;
  citations: QuizCitation[];
}

function validateNotesShape(candidate: unknown): { content: ValidatedNotesContent; sourceLabels: string[]; reason: null } | { content: null; sourceLabels: null; reason: NotesValidationRejectionReason } {
  if (!isPlainObject(candidate)) return { content: null, sourceLabels: null, reason: "MALFORMED_OUTPUT" };
  const { title, summary, keyPoints, importantTerms, examFocus, sourceLabels } = candidate;

  if (!isNonEmptyString(title) || !isNonEmptyString(summary)) return { content: null, sourceLabels: null, reason: "MALFORMED_OUTPUT" };
  if (!Array.isArray(keyPoints) || !keyPoints.every(isNonEmptyString) || keyPoints.length === 0) return { content: null, sourceLabels: null, reason: "MALFORMED_OUTPUT" };
  if (!Array.isArray(importantTerms) || !importantTerms.every((t) => isPlainObject(t) && isNonEmptyString(t.term) && isNonEmptyString(t.definition))) {
    return { content: null, sourceLabels: null, reason: "MALFORMED_OUTPUT" };
  }
  if (examFocus !== undefined && (!Array.isArray(examFocus) || !examFocus.every(isNonEmptyString))) return { content: null, sourceLabels: null, reason: "MALFORMED_OUTPUT" };
  if (!isStringArray(sourceLabels)) return { content: null, sourceLabels: null, reason: "MALFORMED_OUTPUT" };

  const trimmedKeyPoints = (keyPoints as string[]).map((p) => p.trim()).slice(0, MATERIALS_MAX_KEY_POINTS);
  const trimmedTerms = (importantTerms as Record<string, unknown>[]).map((t) => ({ term: (t.term as string).trim(), definition: (t.definition as string).trim() })).slice(0, MATERIALS_MAX_TERMS);
  const trimmedExamFocus = ((examFocus as string[] | undefined) ?? []).map((f) => f.trim()).slice(0, MATERIALS_MAX_EXAM_FOCUS);

  if (isOversized(title, summary, ...trimmedKeyPoints, ...trimmedTerms.flatMap((t) => [t.term, t.definition]), ...trimmedExamFocus)) {
    return { content: null, sourceLabels: null, reason: "OVERSIZED_FIELD" };
  }

  return {
    content: { title: title.trim(), summary: summary.trim(), keyPoints: trimmedKeyPoints, importantTerms: trimmedTerms, examFocus: trimmedExamFocus },
    sourceLabels: sourceLabels as string[],
    reason: null,
  };
}

export function validateGeneratedNotes(context: MaterialValidationContext): NotesValidationResult {
  const shape = validateNotesShape(context.candidate);
  if (shape.reason) return { valid: false, reason: shape.reason, content: null, citations: [] };
  const { content, sourceLabels } = shape;

  if (hasSuspiciousText(content.title, content.summary, ...content.keyPoints, ...content.importantTerms.flatMap((t) => [t.term, t.definition]), ...content.examFocus)) {
    return { valid: false, reason: "SUSPICIOUS_INSTRUCTION_FOLLOWING", content: null, citations: [] };
  }

  const citations = buildCitations(context.labeledEvidence, sourceLabels);
  if (citations.length === 0) return { valid: false, reason: "MISSING_SOURCE_SUPPORT", content: null, citations: [] };
  // Defense-in-depth, normally unreachable: retrieveDocumentChunks() already scopes every candidate
  // chunk to `selectedDocumentIds` before this function ever sees it (mirrors lib/quiz/validate.ts's
  // identical defense-in-depth check).
  if (!citations.every((c) => context.selectedDocumentIds.includes(c.documentId))) {
    return { valid: false, reason: "MISSING_SOURCE_SUPPORT", content: null, citations: [] };
  }

  return { valid: true, reason: null, content, citations };
}

// --- Flashcards ------------------------------------------------------------------------------------

export type FlashcardsValidationRejectionReason = "MALFORMED_OUTPUT" | "INSUFFICIENT_GROUNDED_CARDS";

export interface FlashcardsValidationResult {
  valid: boolean;
  reason: FlashcardsValidationRejectionReason | null;
  cards: Flashcard[];
}

/**
 * Per-card filtering, not a whole-batch reject, for anything narrower than "the response wasn't
 * shaped like a card set at all": an individual card with an empty front/back, an oversized field,
 * suspicious injected text, or citations that don't resolve is silently dropped rather than failing
 * every other otherwise-good card in the same batch. The whole response is rejected only when the
 * top-level shape is wrong (MALFORMED_OUTPUT) or too few cards survive filtering to be a useful
 * study set (INSUFFICIENT_GROUNDED_CARDS).
 */
export function validateGeneratedFlashcards(context: MaterialValidationContext): FlashcardsValidationResult {
  if (!isPlainObject(context.candidate) || !Array.isArray(context.candidate.cards) || context.candidate.cards.length === 0) {
    return { valid: false, reason: "MALFORMED_OUTPUT", cards: [] };
  }

  const survivors: Flashcard[] = [];
  for (const raw of context.candidate.cards as unknown[]) {
    if (!isPlainObject(raw)) continue;
    const { front, back, sourceLabels } = raw;
    if (!isNonEmptyString(front) || !isNonEmptyString(back)) continue;
    if (!isStringArray(sourceLabels)) continue;
    const trimmedFront = front.trim();
    const trimmedBack = back.trim();
    if (isOversized(trimmedFront, trimmedBack)) continue;
    if (hasSuspiciousText(trimmedFront, trimmedBack)) continue;

    const citations = buildCitations(context.labeledEvidence, sourceLabels);
    if (citations.length === 0) continue; // ungrounded card -- dropped, not fatal to the batch
    if (!citations.every((c) => context.selectedDocumentIds.includes(c.documentId))) continue;

    survivors.push({ front: trimmedFront, back: trimmedBack, citations });
    if (survivors.length >= MATERIALS_MAX_FLASHCARDS) break; // bounded cardinality
  }

  if (survivors.length < MATERIALS_MIN_FLASHCARDS) return { valid: false, reason: "INSUFFICIENT_GROUNDED_CARDS", cards: [] };
  return { valid: true, reason: null, cards: survivors };
}
