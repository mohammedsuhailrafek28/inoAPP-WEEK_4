import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { CalibrationValidationError, getCalibrationSignal, isActionable, listCalibrationRecords, openCalibrationPrediction, predictedFromRating, resolveCalibrationPrediction } from "@/lib/learning/calibration";
import { recordLearningEvent } from "@/lib/learning/events";
import { createOrResolveConcept } from "@/lib/learning/concepts";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import type { ConfidenceRating } from "@/types/learning";
import { createFakeLearningSupabase } from "./support/fake-learning-db";

async function setup() {
  const fake = createFakeLearningSupabase();
  const supabase = fake as never;
  const profile = await getOrCreateDefaultProfile({ supabase });
  const { concept } = await createOrResolveConcept({ subject: "Machine Learning", displayName: "Logistic Regression" }, { supabase });
  return { supabase, fake, studentId: profile.id, conceptId: concept.id };
}

/** Opens a prediction, records the outcome event, and resolves against it -- the full real flow. */
async function predictAndResolve(studentId: string, conceptId: string, rating: ConfidenceRating, correct: boolean, supabase: unknown) {
  await openCalibrationPrediction({ studentId, conceptId, rating }, { supabase } as never);
  const event = await recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED", metadata: { correct } }, { supabase } as never);
  return resolveCalibrationPrediction({ studentId, conceptId, sourceEventId: event.id }, { supabase } as never);
}

test("predictedFromRating: §13's exact 1-5 Likert conversion", () => {
  assert.equal(predictedFromRating(1), 0);
  assert.equal(predictedFromRating(2), 0.25);
  assert.equal(predictedFromRating(3), 0.5);
  assert.equal(predictedFromRating(4), 0.75);
  assert.equal(predictedFromRating(5), 1);
});

test("isActionable: §13's exact predicate", () => {
  assert.equal(isActionable(0.3, 5), true);
  assert.equal(isActionable(0.3, 4), false); // sampleCount too low
  assert.equal(isActionable(0.1, 10), false); // bias too small
});

test("a confidence sample is tied to a real, authoritative attempt -- resolving with an unknown event is rejected", async () => {
  const { supabase, studentId, conceptId } = await setup();
  await openCalibrationPrediction({ studentId, conceptId, rating: 3 }, { supabase });
  await assert.rejects(() => resolveCalibrationPrediction({ studentId, conceptId, sourceEventId: randomUUID() }, { supabase }), CalibrationValidationError);
});

test("cannot open a second prediction while one is already open for the same concept", async () => {
  const { supabase, studentId, conceptId } = await setup();
  await openCalibrationPrediction({ studentId, conceptId, rating: 3 }, { supabase });
  await assert.rejects(() => openCalibrationPrediction({ studentId, conceptId, rating: 4 }, { supabase }), CalibrationValidationError);
});

test("duplicate resolution of the same source event is idempotent, not an error", async () => {
  const { supabase, studentId, conceptId } = await setup();
  await openCalibrationPrediction({ studentId, conceptId, rating: 4 }, { supabase });
  const event = await recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED", metadata: { correct: true } }, { supabase });
  const first = await resolveCalibrationPrediction({ studentId, conceptId, sourceEventId: event.id }, { supabase });
  const retry = await resolveCalibrationPrediction({ studentId, conceptId, sourceEventId: event.id }, { supabase });
  assert.equal(first.alreadyProcessed, false);
  assert.equal(retry.alreadyProcessed, true);
  assert.equal(first.record.id, retry.record.id);
});

test("confidence rating bounds are enforced -- only integers 1-5 are accepted", () => {
  assert.throws(() => predictedFromRating(0 as ConfidenceRating), CalibrationValidationError);
  assert.throws(() => predictedFromRating(6 as ConfidenceRating), CalibrationValidationError);
  assert.throws(() => predictedFromRating(2.5 as ConfidenceRating), CalibrationValidationError);
});

test("actual correctness is always derived from the source event, never client-declared -- resolve() takes no correctness parameter", async () => {
  const { supabase, studentId, conceptId } = await setup();
  await openCalibrationPrediction({ studentId, conceptId, rating: 5 }, { supabase });
  const event = await recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED", metadata: { correct: false } }, { supabase });
  // ResolveCalibrationPredictionInput structurally has no `actual`/`correct` field to pass.
  const { record } = await resolveCalibrationPrediction({ studentId, conceptId, sourceEventId: event.id }, { supabase });
  assert.equal(record.actual, 0);
  assert.equal(record.predicted, 1);
  assert.equal(record.delta, 1);
});

test("1-4 resolved samples -> insufficient_evidence", async () => {
  const { supabase, studentId, conceptId } = await setup();
  for (let i = 0; i < 4; i++) await predictAndResolve(studentId, conceptId, 3, true, supabase);
  const signal = await getCalibrationSignal(studentId, { supabase });
  assert.equal(signal.sampleCount, 4);
  assert.equal(signal.state, "insufficient_evidence");
});

test("exactly CALIBRATION_MIN_SAMPLES (5) resolved records -> the metric becomes reportable", async () => {
  const { supabase, studentId, conceptId } = await setup();
  // predicted=0.5 (rating 3), alternating correct/incorrect -> small bias, well within tolerance.
  for (let i = 0; i < 5; i++) await predictAndResolve(studentId, conceptId, 3, i % 2 === 0, supabase);
  const signal = await getCalibrationSignal(studentId, { supabase });
  assert.equal(signal.sampleCount, 5);
  assert.notEqual(signal.state, "insufficient_evidence");
});

test("overconfidence: high self-rated confidence, consistently wrong -> OVERCONFIDENT", async () => {
  const { supabase, studentId, conceptId } = await setup();
  for (let i = 0; i < 5; i++) await predictAndResolve(studentId, conceptId, 5, false, supabase); // predicted=1, actual=0, delta=+1 each
  const signal = await getCalibrationSignal(studentId, { supabase });
  assert.ok(signal.bias !== null && signal.bias > 0);
  assert.equal(signal.actionable, true);
  assert.equal(signal.state, "overconfident");
});

test("underconfidence: low self-rated confidence, consistently correct -> UNDERCONFIDENT", async () => {
  const { supabase, studentId, conceptId } = await setup();
  for (let i = 0; i < 5; i++) await predictAndResolve(studentId, conceptId, 1, true, supabase); // predicted=0, actual=1, delta=-1 each
  const signal = await getCalibrationSignal(studentId, { supabase });
  assert.ok(signal.bias !== null && signal.bias < 0);
  assert.equal(signal.actionable, true);
  assert.equal(signal.state, "underconfident");
});

test("well-calibrated: bias stays within the actionable tolerance -> WELL_CALIBRATED", async () => {
  const { supabase, studentId, conceptId } = await setup();
  // predicted=0.5 each time; alternating correct/incorrect keeps |bias| well under 0.25.
  const outcomes = [true, false, true, false, true];
  for (const correct of outcomes) await predictAndResolve(studentId, conceptId, 3, correct, supabase);
  const signal = await getCalibrationSignal(studentId, { supabase });
  assert.ok(signal.bias !== null && Math.abs(signal.bias) < 0.25);
  assert.equal(signal.actionable, false);
  assert.equal(signal.state, "well_calibrated");
});

test("opening a prediction also records a CONFIDENCE_REPORTED event in the immutable evidence log (§25 retrofit)", async () => {
  const { supabase, fake, studentId, conceptId } = await setup();
  await openCalibrationPrediction({ studentId, conceptId, rating: 4 }, { supabase });
  const confidenceEvents = fake.tables.events.rows.filter((row) => row.event_type === "CONFIDENCE_REPORTED");
  assert.equal(confidenceEvents.length, 1);
  assert.equal(confidenceEvents[0].student_id, studentId);
  assert.equal(confidenceEvents[0].concept_id, conceptId);
  assert.deepEqual(confidenceEvents[0].metadata, { predicted: 0.75 });
});

test("no Gemini inference and no arbitrary client correctness -- listCalibrationRecords exposes only what was actually derived", async () => {
  const { supabase, fake, studentId, conceptId } = await setup();
  await predictAndResolve(studentId, conceptId, 4, true, supabase);
  const records = await listCalibrationRecords(studentId, { supabase });
  assert.equal(records.length, 1);
  assert.equal(records[0].predicted, 0.75);
  assert.equal(records[0].actual, 1);
  assert.equal(fake.tables.calibrationRecords.rows.length, 1);
});
