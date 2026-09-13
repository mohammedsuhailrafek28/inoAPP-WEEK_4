// The pedagogical decision engine's action cascade (ARCHITECTURE.md §17.3, Phase 8) -- module
// path and name match the architecture's own canonical module list exactly (§29:
// "lib/pedagogy/select-action.ts: the 10-action cascade"), not the task prompt's suggested
// lib/learning/pedagogy.ts.
//
// This engine decides WHICH concept and WHICH action; it never generates teaching content (§17.4).
// Gemini has zero authority over any of the decisions here (§32/33) -- nothing in this file imports
// a Gemini client, directly or indirectly, and the pure `selectAction()` below takes no LLM output
// as input at all.
//
// Scope (documented in types/learning.ts's own header comment above PedagogicalDecisionInput):
// this phase implements §17.3's action cascade for an ALREADY-CHOSEN target concept. §17.1's
// per-subject phase FSM and §17.2's phase-dispatched multi-concept selection are deferred to Phase
// 10 (personalized RAG integration), the first point "concepts in the currently selected
// documents" becomes real, queryable, per-learner state -- every one of this phase's own task steps
// is framed around a caller-supplied target concept, never "pick one for me."
//
// No score soup (Step 7): IRT theta, PFA plateau, and raw calibration bias are never read directly
// here -- they arrive pre-baked into `difficultyDecision`/`scaffolding`, computed once by the
// existing Phase 4/7 services and reused verbatim, never recomputed or re-blended.

import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { LEARNING_CONFIG } from "@/lib/learning/constants";
import { getConcept, getConceptByKey } from "@/lib/learning/concepts";
import { getPrerequisiteReadiness } from "@/lib/learning/readiness";
import { getMasteryState } from "@/lib/learning/mastery";
import { getRetentionState } from "@/lib/learning/reviews";
import { calculateRetrievability, daysBetween } from "@/lib/learning/retention";
import { listMisconceptions } from "@/lib/learning/misconceptions";
import { getTransferSignal } from "@/lib/learning/transfer";
import { getScaffoldingDecision } from "@/lib/learning/autonomy";
import { getTargetDifficulty } from "@/lib/pedagogy/difficulty";
import { getLearnerMemoryContext } from "@/lib/learning/memory";
import type { Misconception, NextLearningActionResult, PedagogicalDecision, PedagogicalDecisionInput, PedagogicalSupportingSignals } from "@/types/learning";

export class PedagogyValidationError extends Error {}

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

const MASTERY_ACHIEVED_THRESHOLD = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.MASTERY_ACHIEVED_THRESHOLD.value;
const MIN_EVIDENCE_FOR_ADAPTIVE = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.MIN_EVIDENCE_FOR_ADAPTIVE.value;
const RETENTION_CRITICAL = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.RETENTION_URGENCY_CRITICAL_MAX.value;

export interface PedagogyDependencies {
  supabase?: SupabaseClient;
}

/**
 * §17.3's exact cascade, pure, side-effect free (Step 20): no Supabase import, no I/O. Retention
 * due-ness is the one place a clock matters (Step 26: "retention due-ness is explicitly evaluated
 * against an injected authoritative `now`") -- retrievability is derived here, inside the pure
 * engine, from the raw `stability`/`lastReviewedAt` signals via the already-pure
 * calculateRetrievability()/daysBetween() functions, never pre-resolved by the caller and never
 * read from the real clock. Every other input signal is already fully resolved. First match wins;
 * row 8 is both "the 0.30<=mastery<0.85 practice band" AND the cascade's total fallback ("no
 * override above fired") -- the cascade must always produce exactly one action for any input, and
 * no row past 8 (HINT/CONTINUE, rows 9-10) is ever reachable when a concrete target concept is
 * supplied, since row 10 only fires with no concept at all and row 9 is "always available, not part
 * of the cascade" (§17.3).
 */
export function selectAction(input: PedagogicalDecisionInput, now: Date): PedagogicalDecision {
  const evidenceSufficient = hasSufficientEvidenceCount(input.evidenceCount);
  const retrievability = input.stability !== null && input.lastReviewedAt !== null ? calculateRetrievability(daysBetween(new Date(input.lastReviewedAt), now), input.stability) : null;
  const reviewDue = retrievability !== null && retrievability < RETENTION_CRITICAL && input.pMastery !== null && input.pMastery >= MASTERY_ACHIEVED_THRESHOLD;
  const prerequisiteBlocked = !input.readiness.ready;

  const supportingSignals: PedagogicalSupportingSignals = {
    pMastery: input.pMastery,
    evidenceCount: input.evidenceCount,
    evidenceSufficient,
    retrievability,
    reviewDue,
    prerequisiteBlocked,
    activeMisconceptionCount: input.activeMisconceptions.length,
    transferReadiness: input.transferReadiness,
    difficulty: input.difficultyDecision.recommendedDifficulty,
    scaffoldingLevel: input.scaffolding.level,
  };

  const base = { targetConceptId: input.targetConceptId, targetConceptKey: input.targetConceptKey, difficulty: input.difficultyDecision.recommendedDifficulty, scaffoldingLevel: input.scaffolding.level, supportingSignals };

  // Row 1: retrievability < RETENTION_CRITICAL (0.30) on an already-mastered concept.
  if (reviewDue) {
    return { ...base, action: "SPACED_REVIEW", evidenceSufficient, reasonCodes: ["RETENTION_CRITICAL_ON_MASTERED"], explain: null };
  }

  // Row 2: unready prerequisite -- retarget to the prerequisite Phase 2's deterministic order says
  // to revisit first (readiness.blockers is already in that order, never chosen by this function).
  if (prerequisiteBlocked) {
    const target = input.readiness.blockers[0];
    return {
      action: "PREREQUISITE_REMEDIATION",
      targetConceptId: target ? target.conceptId : input.targetConceptId,
      targetConceptKey: target ? target.conceptKey : input.targetConceptKey,
      difficulty: input.difficultyDecision.recommendedDifficulty,
      scaffoldingLevel: input.scaffolding.level,
      evidenceSufficient,
      reasonCodes: ["PREREQUISITE_BLOCKED"],
      supportingSignals,
      explain: null,
    };
  }

  // Row 3: active (never candidate/resolved) misconception -- EXPLAIN focused on the tag.
  if (input.activeMisconceptions.length > 0) {
    const tag = pickMisconceptionTag(input.activeMisconceptions);
    return { ...base, action: "EXPLAIN", evidenceSufficient, reasonCodes: ["ACTIVE_MISCONCEPTION"], explain: { focus: "misconception", tag } };
  }

  // Row 4: sparse evidence (or never seen -- evidenceCount === 0 is already < the floor).
  if (!evidenceSufficient) {
    return { ...base, action: "EXPLAIN", evidenceSufficient, reasonCodes: ["INSUFFICIENT_EVIDENCE"], explain: null };
  }

  // Row 5/6: mastered. Transfer decides EXPLAIN vs. DEEPEN vs. falling through.
  if (input.pMastery !== null && input.pMastery >= MASTERY_ACHIEVED_THRESHOLD) {
    if (input.transferReadiness === "ready") {
      return { ...base, action: "DEEPEN", evidenceSufficient, reasonCodes: ["TRANSFER_DEMONSTRATED"], explain: null };
    }
    if (input.hasDiverseEvidence) {
      return { ...base, action: "TRANSFER_CHALLENGE", evidenceSufficient, reasonCodes: ["TRANSFER_ELIGIBLE"], explain: null };
    }
    // Mastered, transfer not ready, evidence not yet diverse -- falls through to rows 7/8 exactly
    // as the locked cascade's literal conditions allow (§17.3 states no additional guard here).
  }

  // Row 7: most recent attempt was incorrect -- re-teach at lower scaffolding before re-quizzing.
  if (input.mostRecentAttemptCorrect === false) {
    return { ...base, action: "SIMPLIFY", evidenceSufficient, reasonCodes: ["RECENT_ATTEMPT_INCORRECT"], explain: null };
  }

  // Row 8: the practice band, and the cascade's total fallback -- "no override above fired."
  return { ...base, action: "QUIZ", evidenceSufficient, reasonCodes: ["PRACTICE_BAND"], explain: null };
}

function hasSufficientEvidenceCount(evidenceCount: number): boolean {
  return evidenceCount >= MIN_EVIDENCE_FOR_ADAPTIVE;
}

/** Deterministic tag choice when multiple misconceptions are active: earliest-activated first (first_seen_at), never an arbitrary/LLM choice. */
function pickMisconceptionTag(activeMisconceptions: Misconception[]): string {
  return [...activeMisconceptions].sort((a, b) => new Date(a.firstSeenAt).getTime() - new Date(b.firstSeenAt).getTime())[0].tag;
}

/** "Diverse evidence" (§12): >=2 distinct item types (mcq/short_answer) answered correctly on this concept. */
async function hasDiverseEvidence(studentId: string, conceptId: string, supabase: SupabaseClient): Promise<boolean> {
  const { data, error } = await supabase.from("learning_events").select().eq("student_id", studentId).eq("concept_id", conceptId).eq("event_type", "QUIZ_ANSWERED");
  if (error) throw new Error("Could not load quiz history for diversity check.");
  const correctItemTypes = new Set<string>();
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const metadata = (row.metadata ?? {}) as { correct?: boolean; itemType?: string };
    if (metadata.correct === true) correctItemTypes.add(metadata.itemType ?? "mcq");
  }
  return correctItemTypes.size >= 2;
}

/** The most recent QUIZ_ANSWERED outcome for this concept, or null if never attempted. */
async function mostRecentAttemptCorrect(studentId: string, conceptId: string, supabase: SupabaseClient): Promise<boolean | null> {
  const { data, error } = await supabase.from("learning_events").select().eq("student_id", studentId).eq("concept_id", conceptId).eq("event_type", "QUIZ_ANSWERED").order("occurred_at", { ascending: false }).limit(1);
  if (error) throw new Error("Could not load the most recent attempt.");
  const row = (data ?? [])[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return (row.metadata as { correct?: boolean } | null)?.correct === true;
}

/**
 * Builds the fully-resolved, already-validated input the pure engine consumes (Step 6). Queries
 * DB/services; the pure engine itself never does. Subject/concept scopes stay exactly as owned
 * elsewhere (Step 23): BKT/FSRS/misconceptions/transfer by (student, concept); IRT/PFA/calibration
 * only indirectly, via the already-computed difficulty/scaffolding results. Retention is passed
 * through as raw `stability`/`lastReviewedAt` -- retrievability itself is derived inside
 * `selectAction()` against the caller's injected `now`, not resolved here (Step 26).
 */
export async function buildPedagogicalContext(studentId: string, conceptId: string, dependencies: PedagogyDependencies = {}): Promise<PedagogicalDecisionInput> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const concept = await getConcept(conceptId, { supabase });
  if (!concept) throw new PedagogyValidationError("Unknown concept.");

  const [readiness, masteryState, retentionState, activeMisconceptions, transferSignal, difficultyResult, scaffolding, diverseEvidence, recentCorrect] = await Promise.all([
    getPrerequisiteReadiness(studentId, conceptId, { supabase }),
    getMasteryState(studentId, conceptId, { supabase }),
    getRetentionState(studentId, conceptId, { supabase }),
    listMisconceptions(studentId, { conceptId, status: "active" }, { supabase }), // status='active' filter is structural, not a convention -- a candidate/resolved row can never reach this array
    getTransferSignal(studentId, conceptId, { supabase }),
    getTargetDifficulty(studentId, conceptId, { supabase }),
    getScaffoldingDecision(studentId, { supabase }),
    hasDiverseEvidence(studentId, conceptId, supabase),
    mostRecentAttemptCorrect(studentId, conceptId, supabase),
  ]);

  return {
    targetConceptId: concept.id,
    targetConceptKey: concept.conceptKey,
    readiness,
    pMastery: masteryState?.pMastery ?? null,
    evidenceCount: masteryState?.evidenceCount ?? 0,
    hasDiverseEvidence: diverseEvidence,
    mostRecentAttemptCorrect: recentCorrect,
    stability: retentionState?.stability ?? null,
    lastReviewedAt: retentionState?.lastReviewedAt ?? null,
    activeMisconceptions,
    transferReadiness: transferSignal.readiness,
    difficultyDecision: difficultyResult.decision,
    scaffolding,
  };
}

/**
 * The Step 22 next-activity service: resolves the concept, builds the authoritative context,
 * calls the pure engine, and attaches BOUNDED, clearly-labeled non-authoritative memory context
 * (Step 16) -- structurally separate from the decision itself (see NextLearningActionResult), so
 * nothing downstream can mistake episodic/narrative memory for a signal that influenced the
 * decision. Entirely read-only (Step 20): every call below is a read; nothing here inserts an
 * event, mutates any authoritative table, or creates a session/memory row.
 */
export async function getNextLearningAction(studentId: string, conceptKey: string, dependencies: PedagogyDependencies & { now?: Date } = {}): Promise<NextLearningActionResult> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const now = dependencies.now ?? new Date();
  const concept = await getConceptByKey(conceptKey, { supabase });
  if (!concept) throw new PedagogyValidationError("Unknown concept.");

  const input = await buildPedagogicalContext(studentId, concept.id, { supabase });
  const decision = selectAction(input, now);

  const memoryContext = await getLearnerMemoryContext({ studentId, conceptId: concept.id }, { supabase });
  return {
    decision,
    nonAuthoritativeContext: { recentEpisodes: memoryContext.recentEpisodes, relevantNarratives: memoryContext.relevantNarratives },
  };
}
