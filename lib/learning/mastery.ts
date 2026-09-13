import "server-only";
import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { LEARNING_CONFIG } from "@/lib/learning/constants";
import { defaultBktParams, isMastered, updateBkt } from "@/lib/learning/bkt";
import { getConcept } from "@/lib/learning/concepts";
import { recordLearningEvent } from "@/lib/learning/events";
import { computePracticeSignal, PFA_PLATEAU_WINDOW } from "@/lib/learning/pfa";
import type {
  BktItemType,
  BktOutcome,
  BktParams,
  LearnerConceptState,
  LearnerStateTransition,
  LearningConcept,
  LearningOutcomeEvidence,
  LearningOutcomeResult,
  PracticeSignal,
} from "@/types/learning";

export class MasteryValidationError extends Error {}
export class MasteryConcurrencyError extends Error {}

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

const P_L0_DEFAULT = LEARNING_CONFIG.MODEL_PARAMETERS.BKT_DEFAULT_P_L0.value;
const MIN_EVIDENCE_FOR_ADAPTIVE = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.MIN_EVIDENCE_FOR_ADAPTIVE.value;
const CAS_MAX_RETRIES = 5;
const CAS_CONFLICT_MARKER = "bkt_cas_conflict";

export interface MasteryDependencies {
  supabase?: SupabaseClient;
}

function toState(row: Record<string, unknown>): LearnerConceptState {
  return {
    studentId: row.student_id as string,
    conceptId: row.concept_id as string,
    pMastery: row.p_mastery as number,
    evidenceCount: row.evidence_count as number,
    correctCount: row.correct_count as number,
    incorrectCount: row.incorrect_count as number,
    firstPracticedAt: (row.first_practiced_at as string | null) ?? null,
    lastPracticedAt: (row.last_practiced_at as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function toTransition(row: Record<string, unknown>): LearnerStateTransition {
  return {
    id: row.id as string,
    studentId: row.student_id as string,
    conceptId: row.concept_id as string,
    sourceEventId: row.source_event_id as string,
    algorithm: "bkt",
    configVersion: row.config_version as number,
    outcome: row.outcome as BktOutcome,
    masteryBefore: row.mastery_before as number,
    masteryAfter: row.mastery_after as number,
    opportunitiesBefore: row.opportunities_before as number,
    opportunitiesAfter: row.opportunities_after as number,
    createdAt: row.created_at as string,
  };
}

/** Applies a concept's P(T) override (§7.4) on top of the item-type-scoped global defaults. P(L0) is handled separately -- it only matters at first-ever initialization, not on every update call. */
function resolveBktParams(concept: LearningConcept, itemType: BktItemType): BktParams {
  const base = defaultBktParams(itemType);
  return { ...base, pLearn: concept.defaultPT ?? base.pLearn };
}

async function getState(studentId: string, conceptId: string, supabase: SupabaseClient): Promise<LearnerConceptState | null> {
  const { data, error } = await supabase.from("learner_concept_state").select().eq("student_id", studentId).eq("concept_id", conceptId).maybeSingle();
  if (error) throw new Error("Could not load learner concept state.");
  return data ? toState(data) : null;
}

async function getTransitionByEvent(sourceEventId: string, supabase: SupabaseClient): Promise<LearnerStateTransition> {
  const { data, error } = await supabase.from("learner_state_transitions").select().eq("source_event_id", sourceEventId).maybeSingle();
  if (error || !data) throw new Error("Could not load the mastery transition record.");
  return toTransition(data);
}

function isCasConflict(error: unknown): boolean {
  const message = error && typeof error === "object" && "message" in error ? String((error as { message: unknown }).message) : "";
  return message.includes(CAS_CONFLICT_MARKER);
}

/** Public read: current mastery state for one concept, or null if the student has no evidence on it yet. */
export async function getMasteryState(studentId: string, conceptId: string, dependencies: MasteryDependencies = {}): Promise<LearnerConceptState | null> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  return getState(studentId, conceptId, supabase);
}

/** Public read: every concept the student has at least one scored opportunity on. */
export async function listMasteryStates(studentId: string, dependencies: MasteryDependencies = {}): Promise<LearnerConceptState[]> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const { data, error } = await supabase.from("learner_concept_state").select().eq("student_id", studentId).order("concept_id");
  if (error) throw new Error("Could not load learner concept states.");
  return (data ?? []).map(toState);
}

/** Whether a mastery value should be presented as confident, given how much evidence backs it (§7.5). */
export function hasSufficientEvidence(state: Pick<LearnerConceptState, "evidenceCount">): boolean {
  return state.evidenceCount >= MIN_EVIDENCE_FOR_ADAPTIVE;
}

export { isMastered };

/**
 * The one authoritative path that may ever change learner_concept_state (Step 10, Step 16/17):
 * validated evidence in, a full before/after trace out. There is no API route that exposes this
 * directly -- callers are trusted server code only (tests today; a future quiz-submission route).
 *
 * Concurrency-safe (Step 19): a bounded retry loop around one atomic RPC call. The RPC's own
 * source_event_id UNIQUE constraint makes a retried/duplicate event idempotent; its CAS guard on
 * the learner_concept_state UPSERT makes two genuinely-different concurrent events for the same
 * (student, concept) safe -- a losing attempt re-reads fresh state and retries rather than
 * silently overwriting the winner's update.
 */
export async function applyLearningOutcome(evidence: LearningOutcomeEvidence, dependencies: MasteryDependencies = {}): Promise<LearningOutcomeResult> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();

  if (!evidence.studentId || typeof evidence.studentId !== "string") throw new MasteryValidationError("A student id is required.");
  if (!evidence.conceptId || typeof evidence.conceptId !== "string") throw new MasteryValidationError("A concept id is required.");
  if (!evidence.sourceEventId || typeof evidence.sourceEventId !== "string") throw new MasteryValidationError("A source event id is required.");
  if (evidence.outcome !== "correct" && evidence.outcome !== "incorrect") throw new MasteryValidationError("Outcome must be 'correct' or 'incorrect'.");

  // Verify the source event is real, authoritative evidence -- never trust a client-asserted event id.
  const { data: eventRow, error: eventError } = await supabase.from("learning_events").select().eq("id", evidence.sourceEventId).maybeSingle();
  if (eventError) throw new Error("Could not verify the source event.");
  if (!eventRow) throw new MasteryValidationError("Unknown source event.");
  if (eventRow.student_id !== evidence.studentId) throw new MasteryValidationError("Source event does not belong to this student.");
  if (eventRow.concept_id && eventRow.concept_id !== evidence.conceptId) {
    throw new MasteryValidationError("Source event is associated with a different concept.");
  }

  const concept = await getConcept(evidence.conceptId, { supabase });
  if (!concept) throw new MasteryValidationError("Unknown concept.");

  const params = resolveBktParams(concept, evidence.itemType ?? "mcq");
  const pL0 = concept.defaultPL0 ?? P_L0_DEFAULT;
  const configVersion = LEARNING_CONFIG.version;

  for (let attempt = 0; attempt < CAS_MAX_RETRIES; attempt++) {
    const current = await getState(evidence.studentId, evidence.conceptId, supabase);
    const priorMastery = current?.pMastery ?? pL0;
    const priorEvidenceCount = current?.evidenceCount ?? 0;
    const { mastery } = updateBkt(priorMastery, params, evidence.outcome);

    const { data, error } = await supabase.rpc("apply_bkt_transition", {
      p_transition_id: randomUUID(),
      p_student_id: evidence.studentId,
      p_concept_id: evidence.conceptId,
      p_source_event_id: evidence.sourceEventId,
      p_outcome: evidence.outcome,
      p_prior_mastery: priorMastery,
      p_prior_evidence_count: priorEvidenceCount,
      p_new_mastery: mastery,
      p_config_version: configVersion,
    });

    if (error) {
      if (isCasConflict(error)) continue; // another update landed concurrently -- re-read and retry
      throw new Error("Could not apply the learning outcome.");
    }
    const row = (Array.isArray(data) ? data[0] : data) as { status: string; state: Record<string, unknown> } | undefined;
    if (!row) throw new Error("Could not apply the learning outcome.");

    const transition = await getTransitionByEvent(evidence.sourceEventId, supabase);
    return { state: toState(row.state), transition, alreadyProcessed: row.status === "already_processed" };
  }
  throw new MasteryConcurrencyError("Could not apply the learning outcome after repeated concurrent-update retries.");
}

/**
 * Phase 3's "trusted internal test/update pathway" (Step 7): records the authoritative
 * QUIZ_ANSWERED event and immediately applies it to BKT, as one composed operation. This is the
 * only way scored evidence enters the system this phase -- there is no live quiz UI yet, and this
 * function never fabricates correctness from chat text. A future quiz-submission route replaces
 * only the caller of this pattern, not the pattern itself.
 */
export async function recordScoredOutcome(
  input: { studentId: string; sessionId?: string | null; conceptId: string; outcome: BktOutcome; itemType?: BktItemType; difficulty?: "easy" | "medium" | "hard"; idempotencyKey?: string },
  dependencies: MasteryDependencies = {},
): Promise<LearningOutcomeResult> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const event = await recordLearningEvent(
    {
      studentId: input.studentId,
      sessionId: input.sessionId ?? null,
      eventType: "QUIZ_ANSWERED",
      conceptId: input.conceptId,
      idempotencyKey: input.idempotencyKey,
      // difficulty is stored for a later phase's IRT work and never read by BKT (Step 8).
      metadata: { correct: input.outcome === "correct", itemType: input.itemType ?? "mcq", difficulty: input.difficulty },
    },
    { supabase },
  );
  return applyLearningOutcome(
    { studentId: input.studentId, conceptId: input.conceptId, outcome: input.outcome, sourceEventId: event.id, itemType: input.itemType },
    { supabase },
  );
}

/** PFA practice signal for one concept (§8) -- read-only, never written back into learner_concept_state. */
export async function getPracticeSignal(studentId: string, conceptId: string, dependencies: MasteryDependencies = {}): Promise<PracticeSignal> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const state = await getState(studentId, conceptId, supabase);
  if (!state) return { opportunities: 0, successRate: null, pfaProbability: null, plateaued: false };

  const { data, error } = await supabase
    .from("learning_events")
    .select()
    .eq("student_id", studentId)
    .eq("concept_id", conceptId)
    .eq("event_type", "QUIZ_ANSWERED")
    .order("occurred_at", { ascending: false })
    .limit(PFA_PLATEAU_WINDOW);
  if (error) throw new Error("Could not load recent practice history.");

  const recentOutcomes: BktOutcome[] = (data ?? [])
    .slice()
    .reverse()
    .map((row: Record<string, unknown>) => ((row.metadata as { correct?: boolean } | null)?.correct ? "correct" : "incorrect"));

  return computePracticeSignal(state.correctCount, state.incorrectCount, recentOutcomes);
}

/**
 * Deterministic replay (Step 20): re-derives mastery from P(L0) + the ordered, raw QUIZ_ANSWERED
 * events for (student, concept) -- independent of the transition ledger, which is itself a record
 * of this same process's past outputs, not an independent source to replay against. Used for
 * auditability/debugging and by tests, not as a production rebuild pipeline.
 */
export async function replayMasteryFromEvents(
  studentId: string,
  conceptId: string,
  dependencies: MasteryDependencies = {},
): Promise<{ replayedMastery: number; persistedMastery: number | null; matches: boolean }> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const concept = await getConcept(conceptId, { supabase });
  if (!concept) throw new MasteryValidationError("Unknown concept.");

  const { data, error } = await supabase
    .from("learning_events")
    .select()
    .eq("student_id", studentId)
    .eq("concept_id", conceptId)
    .eq("event_type", "QUIZ_ANSWERED")
    .order("occurred_at", { ascending: true });
  if (error) throw new Error("Could not load evidence for replay.");

  const pL0 = concept.defaultPL0 ?? P_L0_DEFAULT;
  let mastery = pL0;
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const metadata = (row.metadata ?? {}) as { correct?: boolean; itemType?: BktItemType };
    const outcome: BktOutcome = metadata.correct ? "correct" : "incorrect";
    const params = resolveBktParams(concept, metadata.itemType ?? "mcq");
    mastery = updateBkt(mastery, params, outcome).mastery;
  }

  const persisted = await getState(studentId, conceptId, supabase);
  const persistedMastery = persisted?.pMastery ?? null;
  return { replayedMastery: mastery, persistedMastery, matches: persistedMastery !== null && Math.abs(mastery - persistedMastery) < 1e-9 };
}
