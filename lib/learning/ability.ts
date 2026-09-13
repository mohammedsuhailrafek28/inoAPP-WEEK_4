import "server-only";
import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { LEARNING_CONFIG } from "@/lib/learning/constants";
import { defaultTheta, difficultyBandToB, updateTheta } from "@/lib/learning/irt";
import { getConcept } from "@/lib/learning/concepts";
import { applyLearningOutcome, type MasteryDependencies } from "@/lib/learning/mastery";
import { recordLearningEvent } from "@/lib/learning/events";
import type {
  AbilityOutcomeEvidence,
  AbilityOutcomeResult,
  BktItemType,
  DifficultyBand,
  IrtOutcome,
  LearnerAbility,
  LearnerAbilityTransition,
  LearningOutcomeResult,
} from "@/types/learning";

export class AbilityValidationError extends Error {}
export class AbilityConcurrencyError extends Error {}

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

const MIN_EVIDENCE_FOR_ADAPTIVE = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.MIN_EVIDENCE_FOR_ADAPTIVE.value;
const CAS_MAX_RETRIES = 5;
const CAS_CONFLICT_MARKER = "irt_cas_conflict";

export interface AbilityDependencies {
  supabase?: SupabaseClient;
}

function toAbility(row: Record<string, unknown>): LearnerAbility {
  return {
    studentId: row.student_id as string,
    subject: row.subject as string,
    theta: row.theta as number,
    observationCount: row.observation_count as number,
    correctCount: row.correct_count as number,
    incorrectCount: row.incorrect_count as number,
    firstObservedAt: (row.first_observed_at as string | null) ?? null,
    lastObservedAt: (row.last_observed_at as string | null) ?? null,
    phase: (row.phase as LearnerAbility["phase"]) ?? "DIAGNOSTIC",
    phaseChangedAt: (row.phase_changed_at as string | null) ?? null,
    lastSelectedConceptId: (row.last_selected_concept_id as string | null) ?? null,
    lastSelectedAt: (row.last_selected_at as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function toTransition(row: Record<string, unknown>): LearnerAbilityTransition {
  return {
    id: row.id as string,
    studentId: row.student_id as string,
    subject: row.subject as string,
    conceptId: row.concept_id as string,
    sourceEventId: row.source_event_id as string,
    algorithm: "irt",
    configVersion: row.config_version as number,
    itemDifficultyB: row.item_difficulty_b as number,
    expectedProbability: row.expected_probability as number,
    outcome: row.outcome as IrtOutcome,
    thetaBefore: row.theta_before as number,
    thetaAfter: row.theta_after as number,
    observationsBefore: row.observations_before as number,
    observationsAfter: row.observations_after as number,
    createdAt: row.created_at as string,
  };
}

async function getAbilityRow(studentId: string, subject: string, supabase: SupabaseClient): Promise<LearnerAbility | null> {
  const { data, error } = await supabase.from("learner_ability").select().eq("student_id", studentId).eq("subject", subject).maybeSingle();
  if (error) throw new Error("Could not load learner ability.");
  return data ? toAbility(data) : null;
}

async function getTransitionByEvent(sourceEventId: string, supabase: SupabaseClient): Promise<LearnerAbilityTransition> {
  const { data, error } = await supabase.from("learner_ability_transitions").select().eq("source_event_id", sourceEventId).maybeSingle();
  if (error || !data) throw new Error("Could not load the ability transition record.");
  return toTransition(data);
}

function isCasConflict(error: unknown): boolean {
  const message = error && typeof error === "object" && "message" in error ? String((error as { message: unknown }).message) : "";
  return message.includes(CAS_CONFLICT_MARKER);
}

/** Public read: current ability for one subject, or null if the student has no IRT evidence on it yet. */
export async function getAbility(studentId: string, subject: string, dependencies: AbilityDependencies = {}): Promise<LearnerAbility | null> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  return getAbilityRow(studentId, subject, supabase);
}

/**
 * Ensures a `learner_ability` row exists for (studentId, subject) so the phase FSM (§17.1) and
 * anti-repeat state (§17.2) have somewhere to live even before the student has any IRT evidence --
 * mirrors mastery.ts/reviews.ts's own "row created lazily on first touch" convention. Never
 * overwrites an existing row's theta/observation counts.
 */
export async function ensureAbilityRow(studentId: string, subject: string, dependencies: AbilityDependencies = {}): Promise<LearnerAbility> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const existing = await getAbilityRow(studentId, subject, supabase);
  if (existing) return existing;
  // Plain insert, not upsert (no other call site in this codebase uses upsert -- the fake-DB test
  // double doesn't implement it either). A concurrent racer hitting the primary-key conflict just
  // re-reads the row the other writer created; this row's own columns (theta, observation_count)
  // are never touched here, so there is nothing to reconcile beyond "does a row exist."
  const { error: insertError } = await supabase.from("learner_ability").insert({ student_id: studentId, subject });
  if (insertError && !String(insertError.message ?? "").includes("duplicate")) throw new Error("Could not create the learner ability row.");
  const row = await getAbilityRow(studentId, subject, supabase);
  if (!row) throw new Error("Could not create the learner ability row.");
  return row;
}

/**
 * The sole authoritative writer of `learner_ability.phase` (§32's table: "Phase ... Authoritative
 * writer: lib/pedagogy/phase.ts only"). A plain guarded update, not a CAS loop -- phase transitions
 * are recomputed fresh from current state on every call (lib/pedagogy/phase.ts), so a benign race
 * only costs one extra recomputation next call, never a lost or corrupted transition (unlike
 * BKT/IRT/FSRS, no numeric accumulator here that a lost update could desynchronize).
 */
export async function setPhase(studentId: string, subject: string, phase: LearnerAbility["phase"], now: Date, dependencies: AbilityDependencies = {}): Promise<void> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  await ensureAbilityRow(studentId, subject, { supabase });
  const { error } = await supabase.from("learner_ability").update({ phase, phase_changed_at: now.toISOString() }).eq("student_id", studentId).eq("subject", subject);
  if (error) throw new Error("Could not update the learner phase.");
}

/** The sole authoritative writer of the §17.2 anti-repeat pointer. */
export async function setLastSelectedConcept(studentId: string, subject: string, conceptId: string, now: Date, dependencies: AbilityDependencies = {}): Promise<void> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  await ensureAbilityRow(studentId, subject, { supabase });
  const { error } = await supabase.from("learner_ability").update({ last_selected_concept_id: conceptId, last_selected_at: now.toISOString() }).eq("student_id", studentId).eq("subject", subject);
  if (error) throw new Error("Could not update the last-selected concept.");
}

/** Public read: every subject the student has at least one IRT observation on. */
export async function listAbilities(studentId: string, dependencies: AbilityDependencies = {}): Promise<LearnerAbility[]> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const { data, error } = await supabase.from("learner_ability").select().eq("student_id", studentId).order("subject");
  if (error) throw new Error("Could not load learner abilities.");
  return (data ?? []).map(toAbility);
}

/** Whether an ability estimate has enough evidence to be treated as confident (§9.4/§16 step 3) -- reuses BKT's own floor, not a second constant. */
export function hasSufficientAbilityEvidence(ability: Pick<LearnerAbility, "observationCount">): boolean {
  return ability.observationCount >= MIN_EVIDENCE_FOR_ADAPTIVE;
}

/**
 * The one authoritative path that may ever change learner_ability (Phase 4, Step 14/16/17): a
 * bounded CAS retry loop around one atomic RPC, structurally identical to
 * lib/learning/mastery.ts::applyLearningOutcome() -- see that function's docstring for why this
 * shape is concurrency-safe. Never exposed through an API route.
 *
 * Subject is NEVER taken from the caller or from event metadata (Step 15) -- it is always resolved
 * from the evidence's concept via `learning_concepts.subject`.
 */
export async function applyAbilityOutcome(evidence: AbilityOutcomeEvidence, dependencies: AbilityDependencies = {}): Promise<AbilityOutcomeResult> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();

  if (!evidence.studentId || typeof evidence.studentId !== "string") throw new AbilityValidationError("A student id is required.");
  if (!evidence.conceptId || typeof evidence.conceptId !== "string") throw new AbilityValidationError("A concept id is required.");
  if (!evidence.sourceEventId || typeof evidence.sourceEventId !== "string") throw new AbilityValidationError("A source event id is required.");
  if (evidence.outcome !== "correct" && evidence.outcome !== "incorrect") throw new AbilityValidationError("Outcome must be 'correct' or 'incorrect'.");
  if (evidence.difficulty !== "easy" && evidence.difficulty !== "medium" && evidence.difficulty !== "hard") {
    throw new AbilityValidationError("Difficulty must be 'easy', 'medium', or 'hard'.");
  }

  const { data: eventRow, error: eventError } = await supabase.from("learning_events").select().eq("id", evidence.sourceEventId).maybeSingle();
  if (eventError) throw new Error("Could not verify the source event.");
  if (!eventRow) throw new AbilityValidationError("Unknown source event.");
  if (eventRow.student_id !== evidence.studentId) throw new AbilityValidationError("Source event does not belong to this student.");
  if (eventRow.concept_id && eventRow.concept_id !== evidence.conceptId) {
    throw new AbilityValidationError("Source event is associated with a different concept.");
  }

  const concept = await getConcept(evidence.conceptId, { supabase });
  if (!concept) throw new AbilityValidationError("Unknown concept.");
  const subject = concept.subject; // authoritative -- never event metadata (Step 15)

  const b = difficultyBandToB(evidence.difficulty);
  const configVersion = LEARNING_CONFIG.version;

  for (let attempt = 0; attempt < CAS_MAX_RETRIES; attempt++) {
    const current = await getAbilityRow(evidence.studentId, subject, supabase);
    const priorTheta = current?.theta ?? defaultTheta();
    const priorObservationCount = current?.observationCount ?? 0;
    const { theta: newTheta, expectedProbability } = updateTheta(priorTheta, priorObservationCount, b, evidence.outcome);

    const { data, error } = await supabase.rpc("apply_irt_transition", {
      p_transition_id: randomUUID(),
      p_student_id: evidence.studentId,
      p_subject: subject,
      p_concept_id: evidence.conceptId,
      p_source_event_id: evidence.sourceEventId,
      p_item_difficulty_b: b,
      p_expected_probability: expectedProbability,
      p_outcome: evidence.outcome,
      p_prior_theta: priorTheta,
      p_prior_observation_count: priorObservationCount,
      p_new_theta: newTheta,
      p_config_version: configVersion,
    });

    if (error) {
      if (isCasConflict(error)) continue; // another update landed concurrently -- re-read and retry
      throw new Error("Could not apply the ability outcome.");
    }
    const row = (Array.isArray(data) ? data[0] : data) as { status: string; ability: Record<string, unknown> } | undefined;
    if (!row) throw new Error("Could not apply the ability outcome.");

    const transition = await getTransitionByEvent(evidence.sourceEventId, supabase);
    return { ability: toAbility(row.ability), transition, alreadyProcessed: row.status === "already_processed" };
  }
  throw new AbilityConcurrencyError("Could not apply the ability outcome after repeated concurrent-update retries.");
}

/**
 * Deterministic replay (mirrors lib/learning/mastery.ts::replayMasteryFromEvents): re-derives theta
 * from theta=0 + the ordered, raw QUIZ_ANSWERED events for every concept in `subject`, independent
 * of the transition ledger.
 */
export async function replayAbilityFromEvents(
  studentId: string,
  subject: string,
  dependencies: AbilityDependencies = {},
): Promise<{ replayedTheta: number; persistedTheta: number | null; matches: boolean }> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();

  const { data: conceptRows, error: conceptError } = await supabase.from("learning_concepts").select().eq("subject", subject);
  if (conceptError) throw new Error("Could not load concepts for this subject.");
  const conceptIds = new Set((conceptRows ?? []).map((row: Record<string, unknown>) => row.id as string));

  const { data, error } = await supabase
    .from("learning_events")
    .select()
    .eq("student_id", studentId)
    .eq("event_type", "QUIZ_ANSWERED")
    .order("occurred_at", { ascending: true });
  if (error) throw new Error("Could not load evidence for replay.");

  let theta = defaultTheta();
  let observationCount = 0;
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    if (!row.concept_id || !conceptIds.has(row.concept_id as string)) continue; // only this subject's concepts feed this replay
    const metadata = (row.metadata ?? {}) as { correct?: boolean; difficulty?: DifficultyBand };
    const outcome: IrtOutcome = metadata.correct ? "correct" : "incorrect";
    const b = difficultyBandToB(metadata.difficulty ?? "medium");
    const result = updateTheta(theta, observationCount, b, outcome);
    theta = result.theta;
    observationCount += 1;
  }

  const persisted = await getAbilityRow(studentId, subject, supabase);
  const persistedTheta = persisted?.theta ?? null;
  return { replayedTheta: theta, persistedTheta, matches: persistedTheta !== null && Math.abs(theta - persistedTheta) < 1e-9 };
}

/**
 * The trusted internal test/update pathway for BOTH BKT and IRT together (Phase 4, Step 13/31):
 * records ONE authoritative QUIZ_ANSWERED event and feeds it to BKT and IRT independently. Neither
 * consumer blocks the other -- each has its own source_event_id UNIQUE boundary on its own ledger
 * table. This is the composed operation a future quiz-submission route replaces the caller of, not
 * the pattern itself; lib/learning/mastery.ts::recordScoredOutcome() remains available unchanged
 * for BKT-only use.
 */
export async function recordScoredOutcomeWithAbility(
  input: {
    studentId: string;
    sessionId?: string | null;
    conceptId: string;
    outcome: IrtOutcome;
    difficulty: DifficultyBand;
    itemType?: BktItemType;
    idempotencyKey?: string;
  },
  dependencies: AbilityDependencies & MasteryDependencies = {},
): Promise<{ bkt: LearningOutcomeResult; irt: AbilityOutcomeResult }> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const event = await recordLearningEvent(
    {
      studentId: input.studentId,
      sessionId: input.sessionId ?? null,
      eventType: "QUIZ_ANSWERED",
      conceptId: input.conceptId,
      idempotencyKey: input.idempotencyKey,
      metadata: { correct: input.outcome === "correct", itemType: input.itemType ?? "mcq", difficulty: input.difficulty },
    },
    { supabase },
  );

  const bkt = await applyLearningOutcome(
    { studentId: input.studentId, conceptId: input.conceptId, outcome: input.outcome, sourceEventId: event.id, itemType: input.itemType, difficulty: input.difficulty },
    { supabase },
  );
  const irt = await applyAbilityOutcome(
    { studentId: input.studentId, conceptId: input.conceptId, outcome: input.outcome, sourceEventId: event.id, difficulty: input.difficulty },
    { supabase },
  );
  return { bkt, irt };
}
