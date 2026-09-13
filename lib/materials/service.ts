// Materials orchestration + activity logging (Week 4, Phase A/B). Architectural precedent:
// lib/quiz/service.ts's generateQuiz() pipeline -- resolve concept -> retrieve [reused Week 2
// lib/documents/retrieval.ts] -> ONE Gemini call -> validate -> return. No persistence: notes and
// flashcards are computed on demand, exactly like lib/plan/generate.ts's own "not persisted" plan.
//
// Concept identity is client-supplied (conceptKey) and resolved deterministically via
// lib/learning/concepts.ts::getConceptByKey() -- never re-derived from selectNextActivity() here,
// because a caller may want materials for ANY plan item's concept (lib/plan's own ranked list),
// not only the single current next-best-action.

import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getConceptByKey } from "@/lib/learning/concepts";
import { retrieveDocumentChunks, type RetrievalResult } from "@/lib/documents/retrieval";
import { assignEvidenceLabels } from "@/lib/documents/citations";
import { recordAgentActivity } from "@/lib/learning/agent-activity";
import { buildNotesPrompt } from "@/lib/materials/notes";
import { buildFlashcardsPrompt } from "@/lib/materials/flashcards";
import { validateGeneratedFlashcards, validateGeneratedNotes } from "@/lib/materials/validate";
import { generateMaterialRaw, parseGeneratedMaterial, MaterialGenerationError, type MaterialGenerationDependencies, type MaterialPrompt } from "@/lib/materials/client";
import { MATERIALS_MATCH_COUNT } from "@/lib/materials/constants";
import type { FlashcardsGenerationResult, MaterialGenerationRequest, NotesGenerationResult } from "@/types/materials";
import type { LearningConcept } from "@/types/learning";

export class MaterialValidationError extends Error {}

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

export interface MaterialServiceDependencies {
  supabase?: SupabaseClient;
  now?: Date;
  retrieve?: (question: string, documentIds: string[]) => Promise<RetrievalResult>;
  generate?: (prompt: MaterialPrompt, deps?: MaterialGenerationDependencies) => Promise<string>;
}

function validateRequest(request: MaterialGenerationRequest): void {
  if (!request.conceptKey || typeof request.conceptKey !== "string" || !request.conceptKey.trim()) {
    throw new MaterialValidationError("A conceptKey is required.");
  }
  if (!Array.isArray(request.documentIds) || request.documentIds.length === 0 || !request.documentIds.every((id) => typeof id === "string" && id.trim())) {
    throw new MaterialValidationError("Select at least one ready document.");
  }
}

type ResolvedRetrieval = { concept: LearningConcept; retrieval: RetrievalResult } | { retrievalError: string };

/**
 * Concept resolution can throw (MaterialValidationError, an unknown conceptKey) -- that's a genuine
 * request-shape problem the API route should turn into a 400, so it's left to propagate. Retrieval
 * failure (e.g. a stale/removed document id) is NOT a request-shape problem -- mirrors
 * lib/quiz/service.ts::generateQuiz()'s own try/catch around retrieve(), returning a structured
 * `generation_failed` result instead of letting a raw exception surface as an unhandled 500.
 */
async function resolveAndRetrieve(request: MaterialGenerationRequest, dependencies: MaterialServiceDependencies, supabase: SupabaseClient): Promise<ResolvedRetrieval> {
  validateRequest(request);
  const concept = await getConceptByKey(request.conceptKey, { supabase });
  if (!concept) throw new MaterialValidationError("Unknown concept.");

  const retrieve = dependencies.retrieve ?? ((question, documentIds) => retrieveDocumentChunks(question, documentIds, MATERIALS_MATCH_COUNT, undefined, { supabase }));
  try {
    const retrieval = await retrieve(concept.displayName, request.documentIds);
    return { concept, retrieval };
  } catch (error) {
    return { retrievalError: error instanceof Error ? error.message : "Retrieval failed." };
  }
}

/**
 * Phase A: grounded notes for one concept. `retrieveAndRespond`'s three failure branches
 * (insufficient retrieval, Gemini failure, failed validation) never call recordAgentActivity() --
 * only a genuinely generated result does, per Phase C's "never log a failed attempt as if it
 * succeeded" rule.
 */
export async function generateNotesForConcept(studentId: string, request: MaterialGenerationRequest, dependencies: MaterialServiceDependencies = {}): Promise<NotesGenerationResult> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const now = dependencies.now ?? new Date();

  const resolved = await resolveAndRetrieve(request, dependencies, supabase);
  if ("retrievalError" in resolved) return { status: "generation_failed", reason: resolved.retrievalError };
  const { concept, retrieval } = resolved;
  if (!retrieval || retrieval.status !== "sufficient" || retrieval.matches.length === 0) return { status: "insufficient_evidence" };

  const labeled = assignEvidenceLabels(retrieval.matches);
  const prompt = buildNotesPrompt({ conceptDisplayName: concept.displayName, labeledEvidence: labeled });

  let raw: string;
  try {
    raw = await (dependencies.generate ?? ((p) => generateMaterialRaw(p)))(prompt);
  } catch (error) {
    return { status: "generation_failed", reason: error instanceof MaterialGenerationError ? error.message : "Notes generation failed." };
  }

  const candidate = parseGeneratedMaterial(raw);
  const validation = validateGeneratedNotes({ candidate, labeledEvidence: labeled, selectedDocumentIds: request.documentIds });
  if (!validation.valid || !validation.content) return { status: "generation_failed", reason: `Generated notes rejected: ${validation.reason}` };

  const notes = {
    title: validation.content.title,
    conceptId: concept.id,
    conceptKey: concept.conceptKey,
    conceptDisplayName: concept.displayName,
    summary: validation.content.summary,
    keyPoints: validation.content.keyPoints,
    importantTerms: validation.content.importantTerms,
    examFocus: validation.content.examFocus,
    citations: validation.citations,
    generatedAt: now.toISOString(),
  };

  await recordAgentActivity(
    { studentId, subject: concept.subject, kind: "MATERIAL_GENERATED", conceptId: concept.id, conceptKey: concept.conceptKey, metadata: { materialType: "notes", keyPointCount: notes.keyPoints.length } },
    { supabase },
  );

  return { status: "generated", notes };
}

/** Phase B: grounded flashcards for one concept. Same failure-vs-success logging boundary as generateNotesForConcept(). */
export async function generateFlashcardsForConcept(studentId: string, request: MaterialGenerationRequest, dependencies: MaterialServiceDependencies = {}): Promise<FlashcardsGenerationResult> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const now = dependencies.now ?? new Date();

  const resolved = await resolveAndRetrieve(request, dependencies, supabase);
  if ("retrievalError" in resolved) return { status: "generation_failed", reason: resolved.retrievalError };
  const { concept, retrieval } = resolved;
  if (!retrieval || retrieval.status !== "sufficient" || retrieval.matches.length === 0) return { status: "insufficient_evidence" };

  const labeled = assignEvidenceLabels(retrieval.matches);
  const prompt = buildFlashcardsPrompt({ conceptDisplayName: concept.displayName, labeledEvidence: labeled });

  let raw: string;
  try {
    raw = await (dependencies.generate ?? ((p) => generateMaterialRaw(p)))(prompt);
  } catch (error) {
    return { status: "generation_failed", reason: error instanceof MaterialGenerationError ? error.message : "Flashcard generation failed." };
  }

  const candidate = parseGeneratedMaterial(raw);
  const validation = validateGeneratedFlashcards({ candidate, labeledEvidence: labeled, selectedDocumentIds: request.documentIds });
  if (!validation.valid) return { status: "generation_failed", reason: `Generated flashcards rejected: ${validation.reason}` };

  const flashcards = { conceptId: concept.id, conceptKey: concept.conceptKey, conceptDisplayName: concept.displayName, cards: validation.cards, generatedAt: now.toISOString() };

  await recordAgentActivity(
    { studentId, subject: concept.subject, kind: "MATERIAL_GENERATED", conceptId: concept.id, conceptKey: concept.conceptKey, metadata: { materialType: "flashcards", cardCount: flashcards.cards.length } },
    { supabase },
  );

  return { status: "generated", flashcards };
}
