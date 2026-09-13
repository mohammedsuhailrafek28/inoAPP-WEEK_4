import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { TransferValidationError, applyTransferEvidence, computeTransferReadiness, getTransferSignal } from "@/lib/learning/transfer";
import { getMasteryState } from "@/lib/learning/mastery";
import { recordLearningEvent } from "@/lib/learning/events";
import { createOrResolveConcept } from "@/lib/learning/concepts";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { createFakeLearningSupabase } from "./support/fake-learning-db";

async function setup() {
  const fake = createFakeLearningSupabase();
  const supabase = fake as never;
  const profile = await getOrCreateDefaultProfile({ supabase });
  const { concept } = await createOrResolveConcept({ subject: "Machine Learning", displayName: "Linear Regression" }, { supabase });
  return { supabase, fake, studentId: profile.id, conceptId: concept.id };
}

// §25/Phase 7 retrofit: transfer evidence's authoritative event is TRANSFER_ATTEMPTED
// (`dimension`, `score`), not a repurposed QUIZ_ANSWERED.
async function event(studentId: string, conceptId: string, supabase: unknown) {
  return recordLearningEvent({ studentId, conceptId, eventType: "TRANSFER_ATTEMPTED", metadata: {} }, { supabase } as never);
}

test("computeTransferReadiness: §12's exact 3-state ladder, pure", () => {
  const zero = { recallAttempts: 0, recallSuccesses: 0, applicationAttempts: 0, applicationSuccesses: 0, transferAttempts: 0, transferSuccesses: 0 };
  assert.equal(computeTransferReadiness(zero, null), "not_attempted");

  const attemptedLowScore = { ...zero, transferAttempts: 1, applicationAttempts: 1, applicationSuccesses: 1 };
  assert.equal(computeTransferReadiness(attemptedLowScore, 0.4), "attempted");

  const readyCounters = { ...zero, transferAttempts: 1, applicationAttempts: 1, applicationSuccesses: 1 };
  assert.equal(computeTransferReadiness(readyCounters, 0.6), "ready");
  assert.equal(computeTransferReadiness(readyCounters, 0.75), "ready");

  const noApplicationSuccess = { ...zero, transferAttempts: 1 };
  assert.equal(computeTransferReadiness(noApplicationSuccess, 0.9), "attempted"); // high score but no application success yet
});

test("recall correctness does not count toward transfer counters -- levels are fully independent", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const e = await event(studentId, conceptId, supabase);
  const result = await applyTransferEvidence({ studentId, conceptId, level: "recall", score: 1, sourceEventId: e.id }, { supabase });
  assert.equal(result.counters.recallAttempts, 1);
  assert.equal(result.counters.recallSuccesses, 1);
  assert.equal(result.counters.transferAttempts, 0);
  assert.equal(result.counters.applicationAttempts, 0);
});

test("application is tracked separately from transfer", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const e1 = await event(studentId, conceptId, supabase);
  await applyTransferEvidence({ studentId, conceptId, level: "application", score: 0.8, sourceEventId: e1.id }, { supabase });
  const e2 = await event(studentId, conceptId, supabase);
  const result = await applyTransferEvidence({ studentId, conceptId, level: "transfer", score: 0.7, sourceEventId: e2.id }, { supabase });
  assert.equal(result.counters.applicationAttempts, 1);
  assert.equal(result.counters.applicationSuccesses, 1);
  assert.equal(result.counters.transferAttempts, 1);
  assert.equal(result.counters.transferSuccesses, 1);
});

test("the first transfer attempt makes the signal visible (not_attempted -> attempted/ready) -- never shown with zero attempts", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const before = await getTransferSignal(studentId, conceptId, { supabase });
  assert.equal(before.readiness, "not_attempted");
  assert.equal(before.mostRecentTransferScore, null);

  const eApp = await event(studentId, conceptId, supabase);
  await applyTransferEvidence({ studentId, conceptId, level: "application", score: 0.9, sourceEventId: eApp.id }, { supabase });
  const eTransfer = await event(studentId, conceptId, supabase);
  await applyTransferEvidence({ studentId, conceptId, level: "transfer", score: 0.65, sourceEventId: eTransfer.id }, { supabase });

  const after = await getTransferSignal(studentId, conceptId, { supabase });
  assert.equal(after.readiness, "ready");
  assert.equal(after.mostRecentTransferScore, 0.65);
});

test("transfer success (score >= TRANSFER_READY_MIN_SCORE with prior application success) -> ready", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const eApp = await event(studentId, conceptId, supabase);
  await applyTransferEvidence({ studentId, conceptId, level: "application", score: 1, sourceEventId: eApp.id }, { supabase });
  const eTransfer = await event(studentId, conceptId, supabase);
  const result = await applyTransferEvidence({ studentId, conceptId, level: "transfer", score: 0.8, sourceEventId: eTransfer.id }, { supabase });
  assert.equal(result.transition.success, true);
  const signal = await getTransferSignal(studentId, conceptId, { supabase });
  assert.equal(signal.readiness, "ready");
});

test("transfer failure (most recent attempt scores below the ready bar) -> attempted, not ready, and readiness is NOT ratcheted", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const eApp = await event(studentId, conceptId, supabase);
  await applyTransferEvidence({ studentId, conceptId, level: "application", score: 1, sourceEventId: eApp.id }, { supabase });
  const eGood = await event(studentId, conceptId, supabase);
  await applyTransferEvidence({ studentId, conceptId, level: "transfer", score: 0.9, sourceEventId: eGood.id }, { supabase });
  let signal = await getTransferSignal(studentId, conceptId, { supabase });
  assert.equal(signal.readiness, "ready");

  // A fresh transfer failure moves it back from "ready" immediately -- not permanently banked (§12).
  const eBad = await event(studentId, conceptId, supabase);
  await applyTransferEvidence({ studentId, conceptId, level: "transfer", score: 0.3, sourceEventId: eBad.id }, { supabase });
  signal = await getTransferSignal(studentId, conceptId, { supabase });
  assert.equal(signal.readiness, "attempted");
});

test("transfer evidence is deterministic -- reading the signal twice in a row gives the identical result", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const e = await event(studentId, conceptId, supabase);
  await applyTransferEvidence({ studentId, conceptId, level: "transfer", score: 0.55, sourceEventId: e.id }, { supabase });
  const first = await getTransferSignal(studentId, conceptId, { supabase });
  const second = await getTransferSignal(studentId, conceptId, { supabase });
  assert.deepEqual(first, second);
});

test("transfer evidence never mutates BKT mastery", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const e = await event(studentId, conceptId, supabase);
  await applyTransferEvidence({ studentId, conceptId, level: "transfer", score: 1, sourceEventId: e.id }, { supabase });
  // The shared learner_concept_state row now exists (transfer created it), but BKT's OWN fields
  // are untouched -- still the raw placeholder (evidence_count 0, p_mastery at the global default),
  // never a real BKT-computed value, because applyLearningOutcome() was never called.
  const mastery = await getMasteryState(studentId, conceptId, { supabase });
  assert.equal(mastery!.evidenceCount, 0);
  assert.equal(mastery!.pMastery, 0.2);
});

test("rejects an invalid level, an out-of-range score, an unknown source event, and a QUIZ_ANSWERED event (wrong type)", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const e = await event(studentId, conceptId, supabase);
  await assert.rejects(() => applyTransferEvidence({ studentId, conceptId, level: "extreme" as never, score: 0.5, sourceEventId: e.id }, { supabase }), TransferValidationError);
  await assert.rejects(() => applyTransferEvidence({ studentId, conceptId, level: "transfer", score: 1.5, sourceEventId: e.id }, { supabase }), TransferValidationError);
  await assert.rejects(() => applyTransferEvidence({ studentId, conceptId, level: "transfer", score: 0.5, sourceEventId: randomUUID() }, { supabase }), TransferValidationError);

  const quizEvent = await recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED", metadata: { correct: true } }, { supabase });
  await assert.rejects(() => applyTransferEvidence({ studentId, conceptId, level: "transfer", score: 0.5, sourceEventId: quizEvent.id }, { supabase }), TransferValidationError);
});

test("idempotent replay -- the same source event cannot double-apply transfer evidence", async () => {
  const { supabase, fake, studentId, conceptId } = await setup();
  const e = await event(studentId, conceptId, supabase);
  const first = await applyTransferEvidence({ studentId, conceptId, level: "transfer", score: 0.8, sourceEventId: e.id }, { supabase });
  const retry = await applyTransferEvidence({ studentId, conceptId, level: "transfer", score: 0.8, sourceEventId: e.id }, { supabase });
  assert.equal(first.alreadyProcessed, false);
  assert.equal(retry.alreadyProcessed, true);
  assert.equal(retry.counters.transferAttempts, 1);
  assert.equal(fake.tables.transferEvidence.rows.length, 1);
});
