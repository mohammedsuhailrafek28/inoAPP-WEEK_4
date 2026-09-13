// Merges §17's pedagogical decision + §15's scaffolding tier + §22's bounded learner context into
// one server-derived, typed object for lib/documents/rag-prompt.ts (ARCHITECTURE.md §21,
// Phase 10). Module path matches the architecture's own exact module list (§29:
// "lib/personalization/prompt-context.ts merges §17's action + §15's scaffolding tier into
// rag-prompt.ts (§21)").
//
// This is the ONLY new impure orchestration Phase 10 adds on top of everything reused verbatim
// from Phases 2/3/5/6/7/8: lib/pedagogy/select-action.ts::getNextLearningAction() (unchanged),
// lib/learning/memory.ts::getLearnerMemoryContext() (unchanged, now finally given a real RAG call
// site), lib/learning/{mastery,reviews,concepts,profile}.ts (unchanged). No new algorithm, no new
// evidence, no new mutation -- entirely read-only (Step 20: "a personalized RAG QUESTION_ASKED
// event may already be emitted... do not accidentally emit BKT/IRT/FSRS/transfer/misconception/
// calibration evidence merely because an explanation was generated").

import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getConcept, getConceptByKey, listConceptsBySubject } from "@/lib/learning/concepts";
import { getMasteryState } from "@/lib/learning/mastery";
import { getRetentionState } from "@/lib/learning/reviews";
import { calculateRetrievability, daysBetween } from "@/lib/learning/retention";
import { getNextLearningAction, PedagogyValidationError } from "@/lib/pedagogy/select-action";
import { getLearnerMemoryContext } from "@/lib/learning/memory";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { deriveMasteryStage } from "@/lib/learning/olm";
import { buildRevisionCandidateSignal, rankRevisionCandidates } from "@/lib/learning/recommendations";
import { buildBoundedLearnerContext } from "@/lib/learning/context-builder";
import type { PersonalizationPromptInput } from "@/lib/documents/rag-prompt";
import type { PedagogicalAction, PedagogicalReasonCode, DifficultyBand, ScaffoldingLevel } from "@/types/learning";

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

// §21's own explicit list -- the only actions the chat/RAG presentation layer ever receives as a
// teaching-strategy instruction. QUIZ/TRANSFER_CHALLENGE/SPACED_REVIEW/PREREQUISITE_REMEDIATION are
// Phase 9's quiz-generation domain, a different pathway entirely; when the pedagogical engine
// selects one of those for this concept, personalized RAG still personalizes (scaffolding,
// difficulty, weak-concept context), it just carries no teaching-strategy action line, rather than
// inventing a quiz inside a chat answer or silently mislabeling the turn.
const CHAT_PRESENTABLE_ACTIONS: ReadonlySet<PedagogicalAction> = new Set(["EXPLAIN", "SIMPLIFY", "DEEPEN", "CONTINUE", "HINT"]);

export interface PersonalizationRequest {
  studentId: string;
  conceptKey?: string | null; // explicit, trusted-flow-or-client-supplied; NEVER fuzzy-created from arbitrary text (Step 5)
}

export interface PersonalizationMetadata {
  personalizationApplied: boolean;
  targetConceptKey: string | null;
  pedagogicalAction: PedagogicalAction | null;
  difficulty: DifficultyBand | null;
  scaffoldingLevel: ScaffoldingLevel | null;
  reasonCodes: PedagogicalReasonCode[] | null;
}

export interface PersonalizationResult {
  // Ready to hand directly to lib/documents/rag-prompt.ts::buildRagPrompt() -- null when
  // personalizationApplied is false, so the caller never needs to know the filtering/mapping rules
  // below (Step 5's "chat-presentable actions" allowlist) itself.
  prompt: PersonalizationPromptInput | null;
  metadata: PersonalizationMetadata;
}

const EMPTY_RESULT: PersonalizationResult = {
  prompt: null,
  metadata: { personalizationApplied: false, targetConceptKey: null, pedagogicalAction: null, difficulty: null, scaffoldingLevel: null, reasonCodes: null },
};

export interface PromptContextDependencies {
  supabase?: SupabaseClient;
  now?: Date;
}

/**
 * The Phase 10 entry point. Returns `{applied:false, ...}` (Steps 26/27/28's mandatory fallback)
 * whenever no concept can be safely resolved, whenever the resolved concept doesn't exist, or
 * whenever anything below throws -- source-grounded RAG must never be weakened by a personalization
 * failure (Step 28). Never creates a concept (Step 5).
 */
export async function buildPersonalizationContext(request: PersonalizationRequest, dependencies: PromptContextDependencies = {}): Promise<PersonalizationResult> {
  if (!request.conceptKey || typeof request.conceptKey !== "string" || !request.conceptKey.trim()) return EMPTY_RESULT;

  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const now = dependencies.now ?? new Date();

  try {
    const concept = await getConceptByKey(request.conceptKey, { supabase });
    if (!concept) return EMPTY_RESULT; // unknown key -> unresolved -> fallback, never auto-created

    const actionResult = await getNextLearningAction(request.studentId, concept.conceptKey, { supabase, now });
    const decision = actionResult.decision;

    // Step 21: "If Phase 8 retargets to a prerequisite, personalized RAG must teach the
    // prerequisite target selected by the deterministic engine" -- PREREQUISITE_REMEDIATION's
    // `decision.targetConceptId` differs from the concept the request asked about, and every
    // signal below (memory, mastery/retention for the "current concept" stage, weak-concept
    // exclusion) must describe that RETARGETED concept, never the originally-asked-about one.
    const targetConcept = decision.targetConceptId === concept.id ? concept : ((await getConcept(decision.targetConceptId, { supabase })) ?? concept);

    const [memoryContext, profile, siblingConcepts, currentMastery, currentRetention] = await Promise.all([
      getLearnerMemoryContext({ studentId: request.studentId, conceptId: targetConcept.id, subject: targetConcept.subject }, { supabase }),
      getOrCreateDefaultProfile({ supabase }),
      listConceptsBySubject(targetConcept.subject, { supabase }),
      getMasteryState(request.studentId, targetConcept.id, { supabase }),
      getRetentionState(request.studentId, targetConcept.id, { supabase }),
    ]);

    const currentRetrievability = currentRetention?.stability !== null && currentRetention?.stability !== undefined && currentRetention.lastReviewedAt ? calculateRetrievability(daysBetween(new Date(currentRetention.lastReviewedAt), now), currentRetention.stability) : null;
    const currentStage = deriveMasteryStage({
      evidenceCount: currentMastery?.evidenceCount ?? 0,
      pMastery: currentMastery?.pMastery ?? null,
      cardState: currentRetention?.cardState ?? null,
      retrievability: currentRetrievability,
    });

    // §22's "top 2 weak concepts, by revision-ranking (§23)" -- reuses lib/learning/
    // recommendations.ts's canonical §23 implementation (Phase 11) rather than a second copy of
    // the same formula.
    const others = siblingConcepts.filter((c) => c.id !== targetConcept.id);
    const weaknessSignals = await Promise.all(others.map((c) => buildRevisionCandidateSignal(request.studentId, c, now, { supabase })));
    const signalById = new Map(weaknessSignals.map((s) => [s.conceptId, s]));
    const weakConcepts = rankRevisionCandidates(weaknessSignals)
      .slice(0, 2)
      .map((r) => {
        const signal = signalById.get(r.conceptId)!;
        return {
          conceptKey: r.conceptKey,
          displayName: r.displayName,
          stage: deriveMasteryStage({ evidenceCount: signal.evidenceCount, pMastery: signal.pMastery, cardState: signal.cardState, retrievability: signal.retrievability }),
        };
      });

    const activeMisconception = memoryContext.activeMisconceptions[0] ? { tag: memoryContext.activeMisconceptions[0].tag, description: memoryContext.activeMisconceptions[0].description } : null;
    const narrativeMemory = memoryContext.relevantNarratives[0]?.content ?? null;

    const presentableAction = CHAT_PRESENTABLE_ACTIONS.has(decision.action) ? decision.action : null;

    const context = buildBoundedLearnerContext({
      profile: { academicLevel: profile.academicLevel, preferredExplanationStyle: profile.preferredExplanationStyle, preferredPace: profile.preferredPace },
      // Rendered separately as <teaching_strategy> by lib/documents/rag-prompt.ts (Step 31) --
      // omitted here to avoid rendering the same "always included" fields twice (see
      // LearnerContextInput's own header comment in context-builder.ts).
      pedagogicalAction: null,
      scaffoldingLevel: null,
      weakConcepts,
      activeMisconception,
      narrativeMemory,
      currentConcept: { displayName: targetConcept.displayName, stage: currentStage },
    });

    return {
      prompt: { action: presentableAction, difficulty: decision.difficulty, scaffoldingLevel: decision.scaffoldingLevel, contextText: context.text },
      metadata: {
        personalizationApplied: true,
        targetConceptKey: targetConcept.conceptKey,
        pedagogicalAction: decision.action, // the REAL underlying decision, for explainability -- may differ from `prompt.action` when it's a quiz-eligible action filtered out of the chat prompt
        difficulty: decision.difficulty,
        scaffoldingLevel: decision.scaffoldingLevel,
        reasonCodes: decision.reasonCodes,
      },
    };
  } catch (error) {
    // Step 28: personalization is additive -- a failure here must never corrupt or weaken
    // source-grounded RAG. Logged server-side only, never surfaced to the client as an error.
    if (!(error instanceof PedagogyValidationError)) console.error("Personalization context construction failed:", error);
    return EMPTY_RESULT;
  }
}
