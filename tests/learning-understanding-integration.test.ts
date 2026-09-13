// Mandatory Phase 6 cross-model test (Step 40): one authoritative scored event, independently
// consumed by BKT, IRT, FSRS, transfer, and misconception evidence -- each exactly once, none
// double-applying on retry. Calibration is verified separately just below with its own event,
// since a calibration resolution requires an OPEN prediction to exist first (a precondition none
// of the other five subsystems share), but it is exercised against the exact same source event
// mechanics (idempotent resolve, no double-apply).

import assert from "node:assert/strict";
import test from "node:test";
import { recordLearningEvent } from "@/lib/learning/events";
import { applyLearningOutcome } from "@/lib/learning/mastery";
import { applyAbilityOutcome } from "@/lib/learning/ability";
import { applyRetentionOutcome } from "@/lib/learning/reviews";
import { applyTransferEvidence } from "@/lib/learning/transfer";
import { recordMisconceptionEvidence } from "@/lib/learning/misconceptions";
import { openCalibrationPrediction, resolveCalibrationPrediction } from "@/lib/learning/calibration";
import { createOrResolveConcept } from "@/lib/learning/concepts";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { createFakeLearningSupabase } from "./support/fake-learning-db";

async function setup() {
  const fake = createFakeLearningSupabase();
  const supabase = fake as never;
  const profile = await getOrCreateDefaultProfile({ supabase });
  const { concept } = await createOrResolveConcept({ subject: "Data Structures", displayName: "Binary Search" }, { supabase });
  return { supabase, fake, studentId: profile.id, conceptId: concept.id };
}

test("mandatory: one real incorrect answer independently feeds BKT, IRT, FSRS (via QUIZ_ANSWERED), transfer (via TRANSFER_ATTEMPTED), and misconception evidence (via MISCONCEPTION_OBSERVED) -- each exactly once", async () => {
  const { supabase, fake, studentId, conceptId } = await setup();
  // One real interaction, three companion evidence events per §25 (Phase 7 retrofit) -- exactly
  // the "one real action, multiple independent evidence events" pattern already used for
  // BKT+IRT+FSRS sharing QUIZ_ANSWERED, extended to transfer/misconceptions' own dedicated events.
  const event = await recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED", metadata: { correct: false, difficulty: "medium" } }, { supabase });
  const transferEvent = await recordLearningEvent({ studentId, conceptId, eventType: "TRANSFER_ATTEMPTED", metadata: { dimension: "recall", score: 0 } }, { supabase });
  const observedEvent = await recordLearningEvent({ studentId, conceptId, eventType: "MISCONCEPTION_OBSERVED", metadata: { proposedByLlm: true, relatedEventId: event.id } }, { supabase });

  const bkt = await applyLearningOutcome({ studentId, conceptId, outcome: "incorrect", sourceEventId: event.id }, { supabase });
  const irt = await applyAbilityOutcome({ studentId, conceptId, outcome: "incorrect", sourceEventId: event.id, difficulty: "medium" }, { supabase });
  const fsrs = await applyRetentionOutcome({ studentId, conceptId, outcome: "incorrect", sourceEventId: event.id }, { supabase });
  const transfer = await applyTransferEvidence({ studentId, conceptId, level: "recall", score: 0, sourceEventId: transferEvent.id }, { supabase });
  const misconception = await recordMisconceptionEvidence({ studentId, conceptId, tag: "wrong_half_update", description: "Updates the wrong half of the search range.", sourceEventId: observedEvent.id }, { supabase });

  assert.equal(bkt.alreadyProcessed, false);
  assert.equal(irt.alreadyProcessed, false);
  assert.equal(fsrs.alreadyProcessed, false);
  assert.equal(transfer.alreadyProcessed, false);
  assert.equal(misconception.alreadyProcessed, false);

  assert.equal(fake.tables.transitions.rows.length, 1); // BKT
  assert.equal(fake.tables.abilityTransitions.rows.length, 1); // IRT
  assert.equal(fake.tables.retentionTransitions.rows.length, 1); // FSRS
  assert.equal(fake.tables.transferEvidence.rows.length, 1); // transfer
  assert.equal(fake.tables.misconceptionEvidence.rows.length, 1); // misconception

  // Retry the SAME events against all five -- none may double-apply.
  const bktRetry = await applyLearningOutcome({ studentId, conceptId, outcome: "incorrect", sourceEventId: event.id }, { supabase });
  const irtRetry = await applyAbilityOutcome({ studentId, conceptId, outcome: "incorrect", sourceEventId: event.id, difficulty: "medium" }, { supabase });
  const fsrsRetry = await applyRetentionOutcome({ studentId, conceptId, outcome: "incorrect", sourceEventId: event.id }, { supabase });
  const transferRetry = await applyTransferEvidence({ studentId, conceptId, level: "recall", score: 0, sourceEventId: transferEvent.id }, { supabase });
  const misconceptionRetry = await recordMisconceptionEvidence({ studentId, conceptId, tag: "wrong_half_update", description: "Updates the wrong half of the search range.", sourceEventId: observedEvent.id }, { supabase });

  assert.equal(bktRetry.alreadyProcessed, true);
  assert.equal(irtRetry.alreadyProcessed, true);
  assert.equal(fsrsRetry.alreadyProcessed, true);
  assert.equal(transferRetry.alreadyProcessed, true);
  assert.equal(misconceptionRetry.alreadyProcessed, true);

  assert.equal(fake.tables.transitions.rows.length, 1);
  assert.equal(fake.tables.abilityTransitions.rows.length, 1);
  assert.equal(fake.tables.retentionTransitions.rows.length, 1);
  assert.equal(fake.tables.transferEvidence.rows.length, 1);
  assert.equal(fake.tables.misconceptionEvidence.rows.length, 1);

  // All current states remain consistent -- every counter reflects exactly one applied opportunity.
  assert.equal(fake.tables.masteryStates.rows[0].evidence_count, 1);
  assert.equal(fake.tables.abilities.rows[0].observation_count, 1);
  assert.equal(fake.tables.masteryStates.rows[0].reps, 1);
  assert.equal(fake.tables.masteryStates.rows[0].recall_attempts, 1);
  assert.equal(fake.tables.misconceptions.rows[0].evidence_count, 1);
});

test("mandatory (calibration): one authoritative event resolves a calibration prediction exactly once, independent of the other five subsystems", async () => {
  const { supabase, fake, studentId, conceptId } = await setup();
  await openCalibrationPrediction({ studentId, conceptId, rating: 4 }, { supabase });
  const event = await recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED", metadata: { correct: false, difficulty: "medium" } }, { supabase });
  const transferEvent = await recordLearningEvent({ studentId, conceptId, eventType: "TRANSFER_ATTEMPTED", metadata: { dimension: "recall", score: 0 } }, { supabase });

  // The same real interaction also feeds BKT/IRT/FSRS/transfer independently -- calibration's own
  // resolution is untouched by any of them, and vice versa.
  await applyLearningOutcome({ studentId, conceptId, outcome: "incorrect", sourceEventId: event.id }, { supabase });
  await applyAbilityOutcome({ studentId, conceptId, outcome: "incorrect", sourceEventId: event.id, difficulty: "medium" }, { supabase });
  await applyRetentionOutcome({ studentId, conceptId, outcome: "incorrect", sourceEventId: event.id }, { supabase });
  await applyTransferEvidence({ studentId, conceptId, level: "recall", score: 0, sourceEventId: transferEvent.id }, { supabase });

  const first = await resolveCalibrationPrediction({ studentId, conceptId, sourceEventId: event.id }, { supabase });
  const retry = await resolveCalibrationPrediction({ studentId, conceptId, sourceEventId: event.id }, { supabase });
  assert.equal(first.alreadyProcessed, false);
  assert.equal(retry.alreadyProcessed, true);
  assert.equal(fake.tables.calibrationRecords.rows.length, 1);
  assert.equal(first.record.actual, 0);

  // Untouched by calibration: BKT/IRT/FSRS/transfer each still show exactly one application.
  assert.equal(fake.tables.transitions.rows.length, 1);
  assert.equal(fake.tables.abilityTransitions.rows.length, 1);
  assert.equal(fake.tables.retentionTransitions.rows.length, 1);
  assert.equal(fake.tables.transferEvidence.rows.length, 1);
});
