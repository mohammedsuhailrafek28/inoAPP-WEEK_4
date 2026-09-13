// DB-backed retention/review-scheduling service (ARCHITECTURE.md §10, Phase 5) -- the impure
// half of the pure/impure split lib/learning/{bkt,mastery}.ts and {irt,ability}.ts already
// established. `retention.ts` holds the pure FSRS math; this file persists it. Named "reviews" (not
// "retention", already taken by the pure module) after the noun this file actually manages --
// review scheduling/queue reads and the one write path -- matching how mastery.ts/ability.ts are
// named after the state they manage, not their algorithm.
//
// The sole authoritative write path is applyRetentionOutcome() -- never exposed through an API
// route. All timestamps used in the FSRS calculation come from the source event's own server-set
// `occurred_at` (never a fresh capture at call time, and never client-supplied, Step 8) -- this
// also makes replayRetentionFromEvents() exactly reproduce persisted state, since both use the same
// authoritative instant for the same event.

import "server-only";
import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { LEARNING_CONFIG } from "@/lib/learning/constants";
import { applyReview, calculateRetrievability, daysBetween, getReviewStatus, getRetentionUrgency, ratingFromOutcome, type RetentionPriorState } from "@/lib/learning/retention";
import { getConcept } from "@/lib/learning/concepts";
import { recordLearningEvent } from "@/lib/learning/events";
import { applyLearningOutcome, type MasteryDependencies } from "@/lib/learning/mastery";
import { applyAbilityOutcome, type AbilityDependencies } from "@/lib/learning/ability";
import type {
  AbilityOutcomeResult,
  BktItemType,
  BktOutcome,
  CardState,
  DifficultyBand,
  DueReview,
  LearnerRetentionTransition,
  LearningEvent,
  LearningOutcomeResult,
  RetentionOutcomeEvidence,
  RetentionOutcomeResult,
  RetentionRating,
  RetentionState,
} from "@/types/learning";

export class RetentionValidationError extends Error {}
export class RetentionConcurrencyError extends Error {}

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

const CAS_MAX_RETRIES = 5;
const CAS_CONFLICT_MARKER = "fsrs_cas_conflict";

export interface RetentionDependencies {
  supabase?: SupabaseClient;
}

function toRetentionState(row: Record<string, unknown>): RetentionState {
  return {
    studentId: row.student_id as string,
    conceptId: row.concept_id as string,
    stability: (row.stability as number | null) ?? null,
    retentionDifficulty: (row.retention_difficulty as number | null) ?? null,
    cardState: row.card_state as CardState,
    reps: row.reps as number,
    lapses: row.lapses as number,
    lastReviewedAt: (row.last_reviewed_at as string | null) ?? null,
    nextReviewAt: (row.next_review_at as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function toTransition(row: Record<string, unknown>): LearnerRetentionTransition {
  return {
    id: row.id as string,
    studentId: row.student_id as string,
    conceptId: row.concept_id as string,
    sourceEventId: row.source_event_id as string,
    algorithm: "fsrs",
    configVersion: row.config_version as number,
    rating: row.rating as RetentionRating,
    reviewedAt: row.reviewed_at as string,
    elapsedDays: row.elapsed_days as number,
    retrievabilityBefore: (row.retrievability_before as number | null) ?? null,
    stabilityBefore: (row.stability_before as number | null) ?? null,
    stabilityAfter: row.stability_after as number,
    difficultyBefore: (row.difficulty_before as number | null) ?? null,
    difficultyAfter: row.difficulty_after as number,
    cardStateBefore: row.card_state_before as CardState,
    cardStateAfter: row.card_state_after as CardState,
    lapsed: row.lapsed as boolean,
    nextReviewAt: row.next_review_at as string,
    createdAt: row.created_at as string,
  };
}

async function getRow(studentId: string, conceptId: string, supabase: SupabaseClient): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase.from("learner_concept_state").select().eq("student_id", studentId).eq("concept_id", conceptId).maybeSingle();
  if (error) throw new Error("Could not load learner concept state.");
  return data ?? null;
}

async function getTransitionByEvent(sourceEventId: string, supabase: SupabaseClient): Promise<LearnerRetentionTransition> {
  const { data, error } = await supabase.from("learner_retention_transitions").select().eq("source_event_id", sourceEventId).maybeSingle();
  if (error || !data) throw new Error("Could not load the retention transition record.");
  return toTransition(data);
}

function isCasConflict(error: unknown): boolean {
  const message = error && typeof error === "object" && "message" in error ? String((error as { message: unknown }).message) : "";
  return message.includes(CAS_CONFLICT_MARKER);
}

/**
 * Public read: current retention state for one concept, or null if the student has no retention
 * evidence on it yet (Step 13 -- a row created only by BKT, reps === 0, reads as "no state" here,
 * exactly as if the row didn't exist, even though the shared learner_concept_state row does).
 */
export async function getRetentionState(studentId: string, conceptId: string, dependencies: RetentionDependencies = {}): Promise<RetentionState | null> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const row = await getRow(studentId, conceptId, supabase);
  if (!row || (row.reps as number) === 0) return null;
  return toRetentionState(row);
}

/** Public read: every concept the student has at least one real review on. */
export async function listRetentionStates(studentId: string, dependencies: RetentionDependencies = {}): Promise<RetentionState[]> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const { data, error } = await supabase.from("learner_concept_state").select().eq("student_id", studentId).order("concept_id");
  if (error) throw new Error("Could not load learner concept states.");
  return ((data ?? []) as Record<string, unknown>[]).filter((row) => (row.reps as number) > 0).map(toRetentionState);
}

/**
 * The one authoritative path that may ever change learner_concept_state's retention columns (Step
 * 21/25) -- a bounded CAS retry loop around one atomic RPC, structurally identical to
 * lib/learning/mastery.ts::applyLearningOutcome() and lib/learning/ability.ts::applyAbilityOutcome().
 * Never exposed through an API route. `rating` is always derived server-side from `evidence.outcome`
 * (Step 10) -- never accepted from a caller.
 */
export async function applyRetentionOutcome(evidence: RetentionOutcomeEvidence, dependencies: RetentionDependencies = {}): Promise<RetentionOutcomeResult> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();

  if (!evidence.studentId || typeof evidence.studentId !== "string") throw new RetentionValidationError("A student id is required.");
  if (!evidence.conceptId || typeof evidence.conceptId !== "string") throw new RetentionValidationError("A concept id is required.");
  if (!evidence.sourceEventId || typeof evidence.sourceEventId !== "string") throw new RetentionValidationError("A source event id is required.");
  if (evidence.outcome !== "correct" && evidence.outcome !== "incorrect") throw new RetentionValidationError("Outcome must be 'correct' or 'incorrect'.");

  const { data: eventRow, error: eventError } = await supabase.from("learning_events").select().eq("id", evidence.sourceEventId).maybeSingle();
  if (eventError) throw new Error("Could not verify the source event.");
  if (!eventRow) throw new RetentionValidationError("Unknown source event.");
  if (eventRow.student_id !== evidence.studentId) throw new RetentionValidationError("Source event does not belong to this student.");
  if (eventRow.concept_id && eventRow.concept_id !== evidence.conceptId) {
    throw new RetentionValidationError("Source event is associated with a different concept.");
  }

  const concept = await getConcept(evidence.conceptId, { supabase });
  if (!concept) throw new RetentionValidationError("Unknown concept.");

  // Idempotent-replay short-circuit (bugfix): unlike BKT/IRT's pure updates, applyReview() below is
  // time-ordering-sensitive -- it computes daysBetween(a prior state's last_reviewed_at, this
  // event's occurred_at), which throws if that prior state has since moved PAST this event's own
  // timestamp. That happens whenever this exact sourceEventId is (re)processed after a
  // chronologically LATER event for the same (student, concept) has already landed -- a stale
  // retried request, or an idempotent replay run out of original order. Checking here, before ever
  // computing anything, avoids feeding applyReview() a state/timestamp pair its own invariant
  // correctly refuses -- the same "already_processed" answer the RPC below would otherwise have
  // given, just returned before the unsafe recomputation rather than after.
  const { data: existingTransitionRow, error: existingTransitionError } = await supabase.from("learner_retention_transitions").select().eq("source_event_id", evidence.sourceEventId).maybeSingle();
  if (existingTransitionError) throw new Error("Could not verify the retention transition.");
  if (existingTransitionRow) {
    const currentRow = await getRow(evidence.studentId, evidence.conceptId, supabase);
    if (!currentRow) throw new Error("Could not load learner concept state for an already-processed retention transition.");
    return { state: toRetentionState(currentRow), transition: toTransition(existingTransitionRow), alreadyProcessed: true };
  }

  const rating = ratingFromOutcome(evidence.outcome);
  const configVersion = LEARNING_CONFIG.version;
  // The review is treated as having happened at the event's own authoritative, server-set
  // timestamp -- never a fresh capture here, and never client-supplied (Step 8). This also makes
  // replayRetentionFromEvents() reproduce persisted state exactly, since both use this same instant.
  const reviewedAt = new Date(eventRow.occurred_at as string);

  for (let attempt = 0; attempt < CAS_MAX_RETRIES; attempt++) {
    const current = await getRow(evidence.studentId, evidence.conceptId, supabase);
    const priorReps = (current?.reps as number | undefined) ?? 0;
    const isFirstReview = !current || priorReps === 0;
    const priorState: RetentionPriorState | null = isFirstReview
      ? null
      : {
          stability: current!.stability as number,
          difficulty: current!.retention_difficulty as number,
          cardState: current!.card_state as CardState,
          lastReviewedAt: new Date(current!.last_reviewed_at as string),
        };

    const outcome = applyReview(priorState, rating, reviewedAt);

    const { data, error } = await supabase.rpc("apply_retention_transition", {
      p_transition_id: randomUUID(),
      p_student_id: evidence.studentId,
      p_concept_id: evidence.conceptId,
      p_source_event_id: evidence.sourceEventId,
      p_rating: rating,
      p_reviewed_at: reviewedAt.toISOString(),
      p_elapsed_days: outcome.elapsedDays,
      p_retrievability_before: outcome.retrievabilityBefore,
      p_stability_before: priorState?.stability ?? null,
      p_stability_after: outcome.stability,
      p_difficulty_before: priorState?.difficulty ?? null,
      p_difficulty_after: outcome.difficulty,
      p_card_state_before: priorState?.cardState ?? "new",
      p_card_state_after: outcome.cardState,
      p_lapsed: outcome.lapsed,
      p_next_review_at: outcome.nextReviewAt.toISOString(),
      p_prior_reps: priorReps,
      p_config_version: configVersion,
    });

    if (error) {
      if (isCasConflict(error)) continue; // another update landed concurrently -- re-read and retry
      throw new Error("Could not apply the retention outcome.");
    }
    const row = (Array.isArray(data) ? data[0] : data) as { status: string; state: Record<string, unknown> } | undefined;
    if (!row) throw new Error("Could not apply the retention outcome.");

    const transition = await getTransitionByEvent(evidence.sourceEventId, supabase);
    return { state: toRetentionState(row.state), transition, alreadyProcessed: row.status === "already_processed" };
  }
  throw new RetentionConcurrencyError("Could not apply the retention outcome after repeated concurrent-update retries.");
}

/**
 * Deterministic replay (mirrors mastery.ts/ability.ts): re-derives stability/difficulty/card_state/
 * reps/lapses/next_review_at from the ordered, raw QUIZ_ANSWERED events for (student, concept),
 * independent of the transition ledger. Reproduces persisted state exactly because both this replay
 * and the original application used each event's own `occurred_at` as the review instant.
 */
export async function replayRetentionFromEvents(
  studentId: string,
  conceptId: string,
  dependencies: RetentionDependencies = {},
): Promise<{
  replayed: { stability: number | null; difficulty: number | null; cardState: CardState; reps: number; lapses: number; nextReviewAt: string | null };
  persisted: RetentionState | null;
  matches: boolean;
}> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();

  const { data, error } = await supabase
    .from("learning_events")
    .select()
    .eq("student_id", studentId)
    .eq("concept_id", conceptId)
    .eq("event_type", "QUIZ_ANSWERED")
    .order("occurred_at", { ascending: true });
  if (error) throw new Error("Could not load evidence for replay.");

  let prior: RetentionPriorState | null = null;
  let reps = 0;
  let lapses = 0;
  let nextReviewAt: Date | null = null;
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const metadata = (row.metadata ?? {}) as { correct?: boolean };
    const outcome: BktOutcome = metadata.correct ? "correct" : "incorrect";
    const rating = ratingFromOutcome(outcome);
    const reviewedAt = new Date(row.occurred_at as string);
    const result = applyReview(prior, rating, reviewedAt);
    prior = { stability: result.stability, difficulty: result.difficulty, cardState: result.cardState, lastReviewedAt: reviewedAt };
    nextReviewAt = result.nextReviewAt;
    reps += 1;
    if (result.lapsed) lapses += 1;
  }

  const replayed = {
    stability: prior?.stability ?? null,
    difficulty: prior?.difficulty ?? null,
    cardState: (prior?.cardState ?? "new") as CardState,
    reps,
    lapses,
    nextReviewAt: nextReviewAt ? nextReviewAt.toISOString() : null,
  };

  const persisted = await getRetentionState(studentId, conceptId, { supabase });
  const matches =
    persisted !== null &&
    persisted.reps === replayed.reps &&
    persisted.lapses === replayed.lapses &&
    persisted.cardState === replayed.cardState &&
    persisted.stability !== null &&
    replayed.stability !== null &&
    Math.abs(persisted.stability - replayed.stability) < 1e-9 &&
    persisted.retentionDifficulty !== null &&
    replayed.difficulty !== null &&
    Math.abs(persisted.retentionDifficulty - replayed.difficulty) < 1e-9 &&
    persisted.nextReviewAt !== null &&
    replayed.nextReviewAt !== null &&
    new Date(persisted.nextReviewAt).getTime() === new Date(replayed.nextReviewAt).getTime();

  return { replayed, persisted, matches };
}

/**
 * The Step 23 due-review queue: this phase owns retention DUE-NESS only, never overall learning
 * priority (a later pedagogy phase ranks across BKT/PFA/IRT/FSRS together) -- no mastery/PFA/IRT
 * signal is mixed into this list or its ordering.
 */
export async function getDueReviews(studentId: string, now: Date = new Date(), dependencies: RetentionDependencies = {}): Promise<DueReview[]> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const states = await listRetentionStates(studentId, { supabase });

  const due: DueReview[] = [];
  for (const state of states) {
    if (!state.nextReviewAt || !state.lastReviewedAt || state.stability === null) continue; // defensive -- reps>0 rows always have these
    const status = getReviewStatus(new Date(state.nextReviewAt), now);
    if (status !== "due" && status !== "overdue") continue;

    const elapsedDays = daysBetween(new Date(state.lastReviewedAt), now);
    const retrievability = calculateRetrievability(elapsedDays, state.stability);
    const urgency = getRetentionUrgency(retrievability);

    const concept = await getConcept(state.conceptId, { supabase });
    if (!concept) continue;

    due.push({
      conceptId: state.conceptId,
      conceptKey: concept.conceptKey,
      displayName: concept.displayName,
      subject: concept.subject,
      state,
      retrievability,
      urgency: urgency.level,
      reviewStatus: status,
    });
  }
  return due.sort((a, b) => a.retrievability - b.retrievability); // most-decayed first -- ordering only, not a priority score
}

/**
 * The trusted internal test/update pathway for BKT + IRT + FSRS together from ONE authoritative
 * QUIZ_ANSWERED event (Step 9/11/31): each of the three is a genuinely independent consumer, with
 * its own ledger and its own UNIQUE(source_event_id) -- none blocks or double-counts against the
 * others, verified by the mandatory cross-model test in tests/learning-retention-integration.test.ts.
 * Supersedes lib/learning/ability.ts::recordScoredOutcomeWithAbility() as the more complete
 * composition; that narrower function remains available for BKT+IRT-only use.
 */
export async function recordScoredOutcomeWithRetention(
  input: {
    studentId: string;
    sessionId?: string | null;
    conceptId: string;
    outcome: BktOutcome;
    difficulty: DifficultyBand;
    itemType?: BktItemType;
    idempotencyKey?: string;
  },
  dependencies: RetentionDependencies & MasteryDependencies & AbilityDependencies = {},
): Promise<{ event: LearningEvent; bkt: LearningOutcomeResult; irt: AbilityOutcomeResult; fsrs: RetentionOutcomeResult }> {
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
  const fsrs = await applyRetentionOutcome({ studentId: input.studentId, conceptId: input.conceptId, outcome: input.outcome, sourceEventId: event.id }, { supabase });
  // Phase 9 addition: `event` is exposed so lib/quiz/service.ts can correlate its OWN
  // TRANSFER_ATTEMPTED/MISCONCEPTION_OBSERVED events back to this same QUIZ_ANSWERED evidence
  // (§25/§32's relatedEventId correlation, identical to the Phase 7 retrofit's pattern) without
  // duplicating this function's BKT+IRT+FSRS composition to get at the event id.
  return { event, bkt, irt, fsrs };
}
