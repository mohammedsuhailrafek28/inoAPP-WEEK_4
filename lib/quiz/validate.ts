// Quiz generation validation gates (ARCHITECTURE.md §19, Phase 9). Module path matches the
// task's own suggested `lib/quiz/validate.ts`.
//
// §19 says "all nine deterministic gates from Revision 1 stand unmodified," but that Revision 1
// text does not exist anywhere in the current, locked ARCHITECTURE.md (confirmed by a full-
// document grep before writing this file -- only fragmentary schema/policy references remain).
// Since the architecture doesn't supply a more specific alternative here, this file operationalizes
// the Phase 9 task prompt's own detailed gate list verbatim (its Step 13), which is a superset of
// nine gates recognizable in §19's own vocabulary ("difficulty," "target concept," "source
// support"). This is the one place in this phase where the task prompt, not the architecture, is
// the more specific source -- documented per the established "architecture wins when it's more
// specific" rule (this is the exception, not a departure from it).
//
// Pure, side-effect-free: takes the raw generated candidate + already-resolved trusted context
// (labeled retrieval evidence, the request's own concept/documents/action/questionType), returns
// accept/reject. Never calls Gemini, Supabase, or any I/O.

import { LEARNING_CONFIG } from "@/lib/learning/constants";
import { assignEvidenceLabels, buildCitations } from "@/lib/documents/citations";
import type { RetrievalMatch } from "@/lib/documents/retrieval";
import type { GeneratedQuizQuestion, QuestionType, QuizEligibleAction, QuizValidationResult, TransferLevel } from "@/types/learning";

const MAX_FIELD_LENGTH = LEARNING_CONFIG.SAFETY_CLAMPS.QUIZ_MAX_FIELD_LENGTH.value;
const MIN_OPTIONS = LEARNING_CONFIG.SAFETY_CLAMPS.QUIZ_MCQ_MIN_OPTIONS.value;
const MAX_OPTIONS = LEARNING_CONFIG.SAFETY_CLAMPS.QUIZ_MCQ_MAX_OPTIONS.value;

// Documents are untrusted evidence (lib/documents/rag-prompt.ts's own UNTRUSTED_SOURCES_RULES):
// this is the same defense extended to quiz generation output -- if the model's generated fields
// echo an instruction-injection pattern (rather than genuine question content), that's strong
// evidence the retrieved source text steered the generation and the whole candidate is rejected,
// never partially trusted.
const INJECTION_PATTERNS = [/ignore (all |previous |the )?instructions/i, /you are now/i, /system\s*:/i, /reveal (the |your )?(prompt|system|instructions)/i, /disregard (all |previous |the )?/i, /act as (if )?/i];

function isOversized(...fields: (string | undefined)[]): boolean {
  return fields.some((f) => typeof f === "string" && f.length > MAX_FIELD_LENGTH);
}

function hasSuspiciousText(...fields: (string | undefined)[]): boolean {
  return fields.some((f) => typeof f === "string" && INJECTION_PATTERNS.some((pattern) => pattern.test(f)));
}

function defaultTransferDimension(questionType: QuestionType, action: QuizEligibleAction): TransferLevel {
  // §12: "transfer only assigned when the pedagogical engine explicitly requests a TRANSFER_
  // CHALLENGE activity" -- otherwise mcq->recall, short_answer->application. Always resolved here,
  // server-side, from trusted request context -- never trusted from Gemini's own output even when
  // present (§18: "never trusted blindly if present").
  if (action === "TRANSFER_CHALLENGE") return "transfer";
  return questionType === "mcq" ? "recall" : "application";
}

export interface QuizValidationContext {
  candidate: unknown; // raw, untrusted parsed JSON from Gemini
  labeledEvidence: ReturnType<typeof assignEvidenceLabels>;
  selectedDocumentIds: string[]; // the request's own document scope -- citations must stay inside it
  action: QuizEligibleAction;
  // §19's addition: the chunk ids this concept's most recent prior question (if any) was grounded
  // in -- a TRANSFER_CHALLENGE candidate cited identically is context-invalid and falls back to
  // 'application' with a logged warning rather than failing the whole generation.
  priorConceptChunkIds: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Gate 1 + shape checks: malformed output, unsupported type, invalid option count, duplicate options, answer not in options, oversized fields. */
function validateShape(candidate: unknown): { question: GeneratedQuizQuestion; reason: null } | { question: null; reason: "MALFORMED_OUTPUT" | "UNSUPPORTED_QUESTION_TYPE" | "INVALID_OPTION_COUNT" | "DUPLICATE_OPTIONS" | "ANSWER_NOT_IN_OPTIONS" | "OVERSIZED_FIELD" } {
  if (!isPlainObject(candidate)) return { question: null, reason: "MALFORMED_OUTPUT" };
  const { questionType, questionText, options, correctAnswer, explanation, sourceLabels, transferDimension } = candidate;

  if (questionType !== "mcq" && questionType !== "short_answer") return { question: null, reason: "UNSUPPORTED_QUESTION_TYPE" };
  if (typeof questionText !== "string" || !questionText.trim()) return { question: null, reason: "MALFORMED_OUTPUT" };
  if (typeof correctAnswer !== "string" || !correctAnswer.trim()) return { question: null, reason: "MALFORMED_OUTPUT" };
  if (typeof explanation !== "string" || !explanation.trim()) return { question: null, reason: "MALFORMED_OUTPUT" };
  if (!Array.isArray(sourceLabels) || !sourceLabels.every((l) => typeof l === "string")) return { question: null, reason: "MALFORMED_OUTPUT" };

  let normalizedOptions: string[] | undefined;
  if (questionType === "mcq") {
    if (!Array.isArray(options) || !options.every((o) => typeof o === "string")) return { question: null, reason: "MALFORMED_OUTPUT" };
    const trimmed = (options as string[]).map((o) => o.trim());
    if (trimmed.length < MIN_OPTIONS || trimmed.length > MAX_OPTIONS || trimmed.some((o) => !o)) return { question: null, reason: "INVALID_OPTION_COUNT" };
    if (new Set(trimmed).size !== trimmed.length) return { question: null, reason: "DUPLICATE_OPTIONS" };
    if (!trimmed.includes(correctAnswer.trim())) return { question: null, reason: "ANSWER_NOT_IN_OPTIONS" };
    normalizedOptions = trimmed;
  }

  if (isOversized(questionText, correctAnswer, explanation, ...(normalizedOptions ?? []))) return { question: null, reason: "OVERSIZED_FIELD" };

  const resolvedTransferDimension = transferDimension === "recall" || transferDimension === "application" || transferDimension === "transfer" ? transferDimension : undefined;

  return {
    question: {
      questionType,
      questionText: questionText.trim(),
      options: normalizedOptions,
      correctAnswer: correctAnswer.trim(),
      explanation: explanation.trim(),
      sourceLabels: sourceLabels as string[],
      transferDimension: resolvedTransferDimension,
    },
    reason: null,
  };
}

export function validateGeneratedQuestion(context: QuizValidationContext): QuizValidationResult {
  const shape = validateShape(context.candidate);
  if (shape.reason) return { valid: false, reason: shape.reason, citations: [], transferDimension: null, transferFallbackWarning: null };
  const question = shape.question;

  if (hasSuspiciousText(question.questionText, question.explanation, question.correctAnswer, ...(question.options ?? []))) {
    return { valid: false, reason: "SUSPICIOUS_INSTRUCTION_FOLLOWING", citations: [], transferDimension: null, transferFallbackWarning: null };
  }

  const citations = buildCitations(context.labeledEvidence, question.sourceLabels);
  if (citations.length === 0) return { valid: false, reason: "MISSING_SOURCE_SUPPORT", citations: [], transferDimension: null, transferFallbackWarning: null };
  // Defense-in-depth, normally unreachable: retrieveDocumentChunks() already scopes every candidate
  // chunk to `selectedDocumentIds` before this function ever sees it, so a citation pointing outside
  // that scope would mean the labeled-evidence map itself was built incorrectly upstream, not that
  // Gemini did anything -- still checked explicitly rather than assumed.
  if (!citations.every((c) => context.selectedDocumentIds.includes(c.documentId))) {
    return { valid: false, reason: "MISSING_SOURCE_SUPPORT", citations: [], transferDimension: null, transferFallbackWarning: null };
  }

  let resolvedDimension = defaultTransferDimension(question.questionType, context.action);
  let transferFallbackWarning: string | null = null;

  // §19's addition: a TRANSFER_CHALLENGE question cited against the SAME chunk(s) as the concept's
  // most recent prior question is not a genuine transfer context -- fall back to APPLICATION with a
  // logged warning rather than failing the whole quiz.
  if (resolvedDimension === "transfer" && context.priorConceptChunkIds.length > 0) {
    const citedChunkIds = new Set(citations.map((c) => c.chunkId));
    const overlapsEntirely = [...citedChunkIds].every((id) => context.priorConceptChunkIds.includes(id));
    if (overlapsEntirely) {
      resolvedDimension = "application";
      transferFallbackWarning = "TRANSFER_CHALLENGE question cited the same source chunk(s) as this concept's prior question; falling back to an APPLICATION question (§19).";
    }
  }

  return { valid: true, reason: null, citations, transferDimension: resolvedDimension, transferFallbackWarning };
}

export type { RetrievalMatch };
