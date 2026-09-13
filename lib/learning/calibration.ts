// Calibration (ARCHITECTURE.md §13, Phase 6) -- learner confidence vs. actual correctness.
// NOT mastery, NOT ability, NOT full metacognition (Step 20/25): this file only ever produces a
// narrow, factual bias reading, never a broad claim like "student lacks self-awareness."
//
// The ONE deliberate exception to "evidence is append-only" (§13): a calibration_records row is
// OPENED (confidence given before answering) then RESOLVED exactly once (actual outcome known) --
// a real mutation, explicitly flagged as the sole exception, not a precedent for mutating anything
// else. Confidence is always an explicit 1-5 Likert rating tied to an attempt -- never inferred
// from response time, and never Gemini-guessed (Step 21).

import "server-only";
import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { LEARNING_CONFIG } from "@/lib/learning/constants";
import { recordLearningEvent } from "@/lib/learning/events";
import type { CalibrationRecord, CalibrationSignal, CalibrationState, ConfidenceRating, OpenCalibrationPredictionInput, ResolveCalibrationPredictionInput } from "@/types/learning";

export class CalibrationValidationError extends Error {}

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

const ACTIONABLE_BIAS = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.CALIBRATION_ACTIONABLE_BIAS.value;
const MIN_SAMPLES = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.CALIBRATION_MIN_SAMPLES.value;
const ROLLING_WINDOW = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.CALIBRATION_ROLLING_WINDOW.value;
const UNIQUE_VIOLATION = "23505";

export interface CalibrationDependencies {
  supabase?: SupabaseClient;
}

function toRecord(row: Record<string, unknown>): CalibrationRecord {
  return {
    id: row.id as string,
    studentId: row.student_id as string,
    conceptId: (row.concept_id as string | null) ?? null,
    predicted: row.predicted as number,
    actual: (row.actual as number | null) ?? null,
    delta: (row.delta as number | null) ?? null,
    sourceEventId: (row.source_event_id as string | null) ?? null,
    createdAt: row.created_at as string,
    resolvedAt: (row.resolved_at as string | null) ?? null,
  };
}

/** §13's exact predicate, pure -- reused everywhere a calibration verdict is needed. */
export function isActionable(bias: number, sampleCount: number): boolean {
  return sampleCount >= MIN_SAMPLES && Math.abs(bias) >= ACTIONABLE_BIAS;
}

/** predicted = (rating-1)/4 -- §13's exact 1-5 Likert conversion. Never a raw client-supplied 0..1 float. */
export function predictedFromRating(rating: ConfidenceRating): number {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new CalibrationValidationError("Confidence rating must be an integer 1-5.");
  return (rating - 1) / 4;
}

/**
 * Opens a prediction (student self-rates confidence before answering). At most one OPEN record per
 * (student, concept) at a time -- enforced by a partial unique index; opening a second one while
 * the first is still unresolved is rejected, not silently allowed to create ambiguity about which
 * one a later resolve() call means.
 */
export async function openCalibrationPrediction(input: OpenCalibrationPredictionInput, dependencies: CalibrationDependencies = {}): Promise<CalibrationRecord> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  if (!input.studentId || typeof input.studentId !== "string") throw new CalibrationValidationError("A student id is required.");
  if (!input.conceptId || typeof input.conceptId !== "string") throw new CalibrationValidationError("A concept id is required.");
  const predicted = predictedFromRating(input.rating);

  const { data, error } = await supabase
    .from("calibration_records")
    .insert({ id: randomUUID(), student_id: input.studentId, concept_id: input.conceptId, predicted })
    .select()
    .single();

  if (error) {
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
      throw new CalibrationValidationError("A calibration prediction is already open for this concept -- resolve it before opening another.");
    }
    throw new Error("Could not open a calibration prediction.");
  }
  if (!data) throw new Error("Could not open a calibration prediction.");

  // Phase 7 retrofit: §25 names CONFIDENCE_REPORTED (`predicted`) as the event that "opens a
  // calibration_records row" -- Phase 6 wrote the row directly with no entry in the immutable
  // evidence log at all, a gap found on a full re-read of §25.
  await recordLearningEvent({ studentId: input.studentId, conceptId: input.conceptId, eventType: "CONFIDENCE_REPORTED", metadata: { predicted } }, { supabase });

  return toRecord(data);
}

/**
 * Resolves the open prediction for (student, concept) once the real outcome is known. `actual` is
 * derived from the source event's own authoritative correctness -- never client-declared. Idempotent
 * on retry of the same sourceEventId; a genuine "no open prediction" is a hard validation error, not
 * a CAS-retry situation (only one of two concurrent resolutions of the same record can be legitimate).
 */
export async function resolveCalibrationPrediction(input: ResolveCalibrationPredictionInput, dependencies: CalibrationDependencies = {}): Promise<{ record: CalibrationRecord; alreadyProcessed: boolean }> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  if (!input.studentId || typeof input.studentId !== "string") throw new CalibrationValidationError("A student id is required.");
  if (!input.conceptId || typeof input.conceptId !== "string") throw new CalibrationValidationError("A concept id is required.");
  if (!input.sourceEventId || typeof input.sourceEventId !== "string") throw new CalibrationValidationError("A source event id is required.");

  // Idempotency check FIRST (Step 22/28): a retried resolve() of an event that already resolved a
  // record must short-circuit here -- checking "is there still an open record" before this would
  // incorrectly reject a genuine retry as "no open prediction," since resolving it the first time
  // already closed it.
  const { data: existingRows, error: existingError } = await supabase.from("calibration_records").select().eq("student_id", input.studentId).eq("concept_id", input.conceptId);
  if (existingError) throw new Error("Could not load calibration predictions.");
  const rows = (existingRows ?? []) as Record<string, unknown>[];
  const alreadyResolved = rows.find((row) => row.source_event_id === input.sourceEventId);
  if (alreadyResolved) return { record: toRecord(alreadyResolved), alreadyProcessed: true };

  const { data: eventRow, error: eventError } = await supabase.from("learning_events").select().eq("id", input.sourceEventId).maybeSingle();
  if (eventError) throw new Error("Could not verify the source event.");
  if (!eventRow) throw new CalibrationValidationError("Unknown source event.");
  if (eventRow.student_id !== input.studentId) throw new CalibrationValidationError("Source event does not belong to this student.");
  if (eventRow.concept_id && eventRow.concept_id !== input.conceptId) throw new CalibrationValidationError("Source event is associated with a different concept.");
  const metadata = (eventRow.metadata ?? {}) as { correct?: boolean };
  if (typeof metadata.correct !== "boolean") throw new CalibrationValidationError("Source event has no authoritative correctness to resolve against.");

  const openRecord = rows.find((row) => row.actual == null);
  if (!openRecord) throw new CalibrationValidationError("No open calibration prediction exists for this concept.");

  const actual = metadata.correct ? 1 : 0;
  const delta = (openRecord.predicted as number) - actual;

  const { data, error } = await supabase.rpc("resolve_calibration_prediction", {
    p_student_id: input.studentId,
    p_concept_id: input.conceptId,
    p_source_event_id: input.sourceEventId,
    p_actual: actual,
    p_delta: delta,
  });
  if (error) throw new Error("Could not resolve the calibration prediction.");
  const row = (Array.isArray(data) ? data[0] : data) as { status: string; record: Record<string, unknown> } | undefined;
  if (!row) throw new Error("Could not resolve the calibration prediction.");
  return { record: toRecord(row.record), alreadyProcessed: row.status === "already_processed" };
}

/** Public read: every calibration record for a student (mostly for tests/debugging; the Progress panel only ever surfaces the derived signal below, per §22). */
export async function listCalibrationRecords(studentId: string, dependencies: CalibrationDependencies = {}): Promise<CalibrationRecord[]> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const { data, error } = await supabase.from("calibration_records").select().eq("student_id", studentId).order("created_at", { ascending: false });
  if (error) throw new Error("Could not load calibration records.");
  return (data ?? []).map(toRecord);
}

/**
 * §13's bias metric + Step 24's exact display gate. Never exposes a state beyond
 * "insufficient_evidence" below CALIBRATION_MIN_SAMPLES (5) resolved records -- no fake analytics.
 */
export async function getCalibrationSignal(studentId: string, dependencies: CalibrationDependencies = {}): Promise<CalibrationSignal> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  // Fetched unfiltered/unlimited and reduced in JS rather than `.order("resolved_at").limit(...)`
  // at the query level -- Postgres' default NULLS FIRST on a DESC order would put still-OPEN
  // (resolved_at IS NULL) records ahead of genuinely resolved ones, corrupting the "most recent 20
  // resolved" window. Fine at this app's single-student data scale.
  const { data, error } = await supabase.from("calibration_records").select().eq("student_id", studentId);
  if (error) throw new Error("Could not load calibration history.");
  const resolved = ((data ?? []) as Record<string, unknown>[])
    .filter((row) => row.resolved_at != null)
    .sort((a, b) => new Date(b.resolved_at as string).getTime() - new Date(a.resolved_at as string).getTime())
    .slice(0, ROLLING_WINDOW);

  const sampleCount = resolved.length;
  const bias = sampleCount > 0 ? resolved.reduce((sum, row) => sum + (row.delta as number), 0) / sampleCount : null;
  const actionable = bias !== null && isActionable(bias, sampleCount);

  let state: CalibrationState;
  if (sampleCount < MIN_SAMPLES) state = "insufficient_evidence";
  else if (!actionable) state = "well_calibrated";
  else state = (bias as number) > 0 ? "overconfident" : "underconfident";

  return { studentId, sampleCount, bias, actionable, state };
}
