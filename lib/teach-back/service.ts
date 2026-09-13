// Teach-Back orchestration (Phase 2/4). Architectural precedent: lib/materials/service.ts's
// generateNotesForConcept() pipeline -- resolve concept -> retrieve [reused Week 2
// lib/documents/retrieval.ts] -> ONE Gemini call -> validate -> return. No persistence, no learner-
// state mutation anywhere in this file (see lib/teach-back/evidence-policy.ts for why).
//
// Concept identity is client-supplied (conceptKey) and resolved deterministically via
// lib/learning/concepts.ts::getConceptByKey() -- subject is always derived from the resolved concept,
// never trusted as a separate client field (mirrors lib/materials/service.ts's own boundary).

import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getConceptByKey } from "@/lib/learning/concepts";
import { retrieveDocumentChunks, type RetrievalResult } from "@/lib/documents/retrieval";
import { assignEvidenceLabels } from "@/lib/documents/citations";
import { buildInitialEvaluationPrompt, buildFollowUpEvaluationPrompt } from "@/lib/teach-back/evaluate";
import { validateTeachBackEvaluation } from "@/lib/teach-back/validate";
import { computeEvidenceEligibility } from "@/lib/teach-back/evidence-policy";
import { generateMaterialRaw, parseGeneratedMaterial, MaterialGenerationError, type MaterialGenerationDependencies, type MaterialPrompt } from "@/lib/materials/client";
import { TEACH_BACK_MATCH_COUNT, TEACH_BACK_MAX_EXPLANATION_LENGTH } from "@/lib/teach-back/constants";
import type { LearningConcept } from "@/types/learning";
import type { TeachBackEvaluateRequest, TeachBackEvaluateResult, TeachBackFollowUpEvaluateResult, TeachBackFollowUpRequest } from "@/types/teach-back";

export class TeachBackValidationError extends Error {}

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

export interface TeachBackServiceDependencies {
  supabase?: SupabaseClient;
  now?: Date;
  retrieve?: (question: string, documentIds: string[]) => Promise<RetrievalResult>;
  generate?: (prompt: MaterialPrompt, deps?: MaterialGenerationDependencies) => Promise<string>;
}

function validateExplanationText(label: string, text: unknown): string {
  if (typeof text !== "string" || !text.trim()) throw new TeachBackValidationError(`${label} is required.`);
  const trimmed = text.trim();
  if (trimmed.length > TEACH_BACK_MAX_EXPLANATION_LENGTH) {
    throw new TeachBackValidationError(`${label} must be ${TEACH_BACK_MAX_EXPLANATION_LENGTH} characters or fewer.`);
  }
  return trimmed;
}

function validateDocumentIds(documentIds: unknown): string[] {
  if (!Array.isArray(documentIds) || documentIds.length === 0 || !documentIds.every((id) => typeof id === "string" && id.trim())) {
    throw new TeachBackValidationError("Select at least one ready document.");
  }
  return documentIds;
}

type ResolvedRetrieval = { concept: LearningConcept; retrieval: RetrievalResult } | { retrievalError: string };

/** Mirrors lib/materials/service.ts::resolveAndRetrieve()'s exact try/catch-around-retrieve() shape -- a retrieval failure is a structured `generation_failed` result, never an unhandled throw. */
async function resolveAndRetrieve(conceptKey: string, documentIds: string[], dependencies: TeachBackServiceDependencies, supabase: SupabaseClient): Promise<ResolvedRetrieval> {
  const concept = await getConceptByKey(conceptKey, { supabase });
  if (!concept) throw new TeachBackValidationError("Unknown concept.");

  const retrieve = dependencies.retrieve ?? ((question, ids) => retrieveDocumentChunks(question, ids, TEACH_BACK_MATCH_COUNT, undefined, { supabase }));
  try {
    const retrieval = await retrieve(concept.displayName, documentIds);
    return { concept, retrieval };
  } catch (error) {
    return { retrievalError: error instanceof Error ? error.message : "Retrieval failed." };
  }
}

export async function evaluateTeachBack(studentId: string, request: TeachBackEvaluateRequest, dependencies: TeachBackServiceDependencies = {}): Promise<TeachBackEvaluateResult> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const now = dependencies.now ?? new Date();

  if (!request.conceptKey || typeof request.conceptKey !== "string" || !request.conceptKey.trim()) throw new TeachBackValidationError("A conceptKey is required.");
  const documentIds = validateDocumentIds(request.documentIds);
  const explanation = validateExplanationText("An explanation", request.explanation);

  const resolved = await resolveAndRetrieve(request.conceptKey, documentIds, dependencies, supabase);
  if ("retrievalError" in resolved) return { status: "generation_failed", reason: resolved.retrievalError };
  const { concept, retrieval } = resolved;
  if (!retrieval || retrieval.status !== "sufficient" || retrieval.matches.length === 0) return { status: "insufficient_evidence" };

  const labeled = assignEvidenceLabels(retrieval.matches);
  const prompt = buildInitialEvaluationPrompt({ conceptDisplayName: concept.displayName, explanation, labeledEvidence: labeled });

  let raw: string;
  try {
    raw = await (dependencies.generate ?? ((p) => generateMaterialRaw(p)))(prompt);
  } catch (error) {
    return { status: "generation_failed", reason: error instanceof MaterialGenerationError ? error.message : "Teach-Back evaluation failed." };
  }

  const candidate = parseGeneratedMaterial(raw);
  const validation = validateTeachBackEvaluation({ candidate, labeledEvidence: labeled, selectedDocumentIds: documentIds, requireFollowUpQuestion: true });
  if (!validation.valid || !validation.fields || !validation.followUpQuestion) return { status: "generation_failed", reason: `Evaluation rejected: ${validation.reason}` };

  return {
    status: "evaluated",
    evaluation: {
      conceptId: concept.id,
      conceptKey: concept.conceptKey,
      conceptDisplayName: concept.displayName,
      understanding: validation.fields.understanding,
      strengths: validation.fields.strengths,
      missingIdeas: validation.fields.missingIdeas,
      questionableClaims: validation.fields.questionableClaims,
      followUpQuestion: validation.followUpQuestion,
      citations: validation.citations,
      generatedAt: now.toISOString(),
    },
  };
}

export async function evaluateTeachBackFollowUp(studentId: string, request: TeachBackFollowUpRequest, dependencies: TeachBackServiceDependencies = {}): Promise<TeachBackFollowUpEvaluateResult> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const now = dependencies.now ?? new Date();

  if (!request.conceptKey || typeof request.conceptKey !== "string" || !request.conceptKey.trim()) throw new TeachBackValidationError("A conceptKey is required.");
  const documentIds = validateDocumentIds(request.documentIds);
  const originalExplanation = validateExplanationText("The original explanation", request.originalExplanation);
  const followUpQuestion = validateExplanationText("The follow-up question", request.followUpQuestion);
  const followUpAnswer = validateExplanationText("A follow-up answer", request.followUpAnswer);

  const resolved = await resolveAndRetrieve(request.conceptKey, documentIds, dependencies, supabase);
  if ("retrievalError" in resolved) return { status: "generation_failed", reason: resolved.retrievalError };
  const { concept, retrieval } = resolved;
  if (!retrieval || retrieval.status !== "sufficient" || retrieval.matches.length === 0) return { status: "insufficient_evidence" };

  const labeled = assignEvidenceLabels(retrieval.matches);
  const prompt = buildFollowUpEvaluationPrompt({ conceptDisplayName: concept.displayName, originalExplanation, followUpQuestion, followUpAnswer, labeledEvidence: labeled });

  let raw: string;
  try {
    raw = await (dependencies.generate ?? ((p) => generateMaterialRaw(p)))(prompt);
  } catch (error) {
    return { status: "generation_failed", reason: error instanceof MaterialGenerationError ? error.message : "Teach-Back follow-up evaluation failed." };
  }

  const candidate = parseGeneratedMaterial(raw);
  const validation = validateTeachBackEvaluation({ candidate, labeledEvidence: labeled, selectedDocumentIds: documentIds, requireFollowUpQuestion: false });
  if (!validation.valid || !validation.fields) return { status: "generation_failed", reason: `Evaluation rejected: ${validation.reason}` };

  const eligibility = computeEvidenceEligibility({ understanding: validation.fields.understanding, questionableClaims: validation.fields.questionableClaims, completedFollowUp: true });

  return {
    status: "evaluated",
    result: {
      conceptId: concept.id,
      conceptKey: concept.conceptKey,
      conceptDisplayName: concept.displayName,
      understanding: validation.fields.understanding,
      strengths: validation.fields.strengths,
      missingIdeas: validation.fields.missingIdeas,
      questionableClaims: validation.fields.questionableClaims,
      citations: validation.citations,
      wouldQualifyForEvidence: eligibility.eligible,
      generatedAt: now.toISOString(),
    },
  };
}
