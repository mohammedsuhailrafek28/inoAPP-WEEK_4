// Teach-Back evaluation validation gates (Phase 2). Architectural precedent: lib/materials/validate.ts
// and lib/quiz/validate.ts -- pure, side-effect-free, takes the raw generated candidate + already-
// resolved trusted context (labeled retrieval evidence, the request's own document scope), returns
// accept/reject. Never calls Gemini, Supabase, or any I/O.
//
// This is the ONLY gate between Gemini's raw output and anything downstream -- validated output is
// still never applied to learner state by this file or any caller (see
// lib/teach-back/evidence-policy.ts): validation governs SHAPE and GROUNDING safety, not authority
// over mastery.

import { buildCitations } from "@/lib/documents/citations";
import { TEACH_BACK_MAX_FIELD_LENGTH, TEACH_BACK_MAX_LIST_ITEMS } from "@/lib/teach-back/constants";
import type { TeachBackUnderstanding } from "@/types/teach-back";
import type { QuizCitation } from "@/types/progress";
import type { LabeledEvidence } from "@/types/rag";

// Mirrors lib/materials/validate.ts's own INJECTION_PATTERNS exactly -- the same defense (retrieved
// document text AND, here, the learner's own free text are both untrusted; a generated field
// echoing an instruction-injection pattern is strong evidence something upstream steered the
// generation) applied to teach-back's own output fields.
const INJECTION_PATTERNS = [/ignore (all |previous |the )?instructions/i, /you are now/i, /system\s*:/i, /reveal (the |your )?(prompt|system|instructions)/i, /disregard (all |previous |the )?/i, /act as (if )?/i, /mark (this|it) as (strong|correct|developing)/i];

const UNDERSTANDING_LEVELS: readonly TeachBackUnderstanding[] = ["INSUFFICIENT", "DEVELOPING", "STRONG"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isOversized(...fields: (string | undefined)[]): boolean {
  return fields.some((f) => typeof f === "string" && f.length > TEACH_BACK_MAX_FIELD_LENGTH);
}

function hasSuspiciousText(...fields: (string | undefined)[]): boolean {
  return fields.some((f) => typeof f === "string" && INJECTION_PATTERNS.some((pattern) => pattern.test(f)));
}

export type TeachBackRejectionReason = "MALFORMED_OUTPUT" | "OVERSIZED_FIELD" | "SUSPICIOUS_INSTRUCTION_FOLLOWING" | "MISSING_SOURCE_SUPPORT";

export interface TeachBackCoreFields {
  understanding: TeachBackUnderstanding;
  strengths: string[];
  missingIdeas: string[];
  questionableClaims: string[];
}

export interface TeachBackValidationContext {
  candidate: unknown; // raw, untrusted parsed JSON from Gemini
  labeledEvidence: LabeledEvidence[];
  selectedDocumentIds: string[];
  requireFollowUpQuestion: boolean; // true for the initial evaluation, false for the final (follow-up) evaluation
}

export interface TeachBackValidationResult {
  valid: boolean;
  reason: TeachBackRejectionReason | null;
  fields: TeachBackCoreFields | null;
  followUpQuestion: string | null; // non-null only when requireFollowUpQuestion was true and validation succeeded
  citations: QuizCitation[];
}

function trimList(value: string[]): string[] {
  return value.map((v) => v.trim()).filter(Boolean).slice(0, TEACH_BACK_MAX_LIST_ITEMS);
}

export function validateTeachBackEvaluation(context: TeachBackValidationContext): TeachBackValidationResult {
  const fail = (reason: TeachBackRejectionReason): TeachBackValidationResult => ({ valid: false, reason, fields: null, followUpQuestion: null, citations: [] });

  const candidate = context.candidate;
  if (!isPlainObject(candidate)) return fail("MALFORMED_OUTPUT");
  const { understanding, strengths, missingIdeas, questionableClaims, sourceLabels, followUpQuestion } = candidate;

  if (typeof understanding !== "string" || !UNDERSTANDING_LEVELS.includes(understanding as TeachBackUnderstanding)) return fail("MALFORMED_OUTPUT");
  if (!isStringArray(strengths) || !isStringArray(missingIdeas) || !isStringArray(questionableClaims)) return fail("MALFORMED_OUTPUT");
  if (!isStringArray(sourceLabels)) return fail("MALFORMED_OUTPUT");
  if (context.requireFollowUpQuestion && !isNonEmptyString(followUpQuestion)) return fail("MALFORMED_OUTPUT");

  const trimmedStrengths = trimList(strengths);
  const trimmedMissing = trimList(missingIdeas);
  const trimmedQuestionable = trimList(questionableClaims);
  const trimmedFollowUp = context.requireFollowUpQuestion ? (followUpQuestion as string).trim() : null;

  if (isOversized(...trimmedStrengths, ...trimmedMissing, ...trimmedQuestionable, trimmedFollowUp ?? undefined)) return fail("OVERSIZED_FIELD");
  if (hasSuspiciousText(...trimmedStrengths, ...trimmedMissing, ...trimmedQuestionable, trimmedFollowUp ?? undefined)) return fail("SUSPICIOUS_INSTRUCTION_FOLLOWING");

  const citations = buildCitations(context.labeledEvidence, sourceLabels as string[]);
  if (citations.length === 0) return fail("MISSING_SOURCE_SUPPORT");
  // Defense-in-depth, normally unreachable: retrieveDocumentChunks() already scopes every candidate
  // chunk to `selectedDocumentIds` before this function ever sees it (mirrors lib/quiz/validate.ts's
  // and lib/materials/validate.ts's identical defense-in-depth check).
  if (!citations.every((c) => context.selectedDocumentIds.includes(c.documentId))) return fail("MISSING_SOURCE_SUPPORT");

  return {
    valid: true,
    reason: null,
    fields: { understanding: understanding as TeachBackUnderstanding, strengths: trimmedStrengths, missingIdeas: trimmedMissing, questionableClaims: trimmedQuestionable },
    followUpQuestion: trimmedFollowUp,
    citations,
  };
}
