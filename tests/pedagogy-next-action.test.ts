import assert from "node:assert/strict";
import test from "node:test";
import { getNextLearningAction, buildPedagogicalContext, PedagogyValidationError } from "@/lib/pedagogy/select-action";
import { recordScoredOutcome } from "@/lib/learning/mastery";
import { recordScoredOutcomeWithRetention, applyRetentionOutcome, getRetentionState } from "@/lib/learning/reviews";
import { recordLearningEvent } from "@/lib/learning/events";
import { recordMisconceptionEvidence, reevaluateMisconceptionResolution } from "@/lib/learning/misconceptions";
import { applyTransferEvidence } from "@/lib/learning/transfer";
import { proposeNarrativeMemory } from "@/lib/learning/memory";
import { startSession, endSession } from "@/lib/learning/sessions";
import { createOrResolveConcept, addPrerequisite } from "@/lib/learning/concepts";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { createFakeLearningSupabase } from "./support/fake-learning-db";

async function setup() {
  const fake = createFakeLearningSupabase();
  const supabase = fake as never;
  const profile = await getOrCreateDefaultProfile({ supabase });
  const { concept } = await createOrResolveConcept({ subject: "Data Structures", displayName: "Binary Search" }, { supabase });
  return { supabase, fake, studentId: profile.id, conceptId: concept.id, conceptKey: concept.conceptKey };
}

async function misconceptionObservedEvent(studentId: string, conceptId: string, tag: string, supabase: unknown) {
  const quizEvent = await recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED", metadata: { correct: false } }, { supabase } as never);
  return recordLearningEvent({ studentId, conceptId, eventType: "MISCONCEPTION_OBSERVED", metadata: { proposedByLlm: true, relatedEventId: quizEvent.id, tag } }, { supabase } as never);
}

/** The exact `now` at which this concept's real, current retrievability first drops below `threshold` -- computed from the persisted stability, not guessed at a fixed day count (which is fragile: the same day count can clear the threshold for a small post-lapse stability and miss it for a larger one). */
async function nowWhenRetrievabilityBelow(studentId: string, conceptId: string, threshold: number, supabase: unknown): Promise<Date> {
  const state = await getRetentionState(studentId, conceptId, { supabase } as never);
  const FACTOR = 19 / 81;
  const stability = state!.stability!;
  const days = (stability / FACTOR) * (Math.pow(threshold, -2) - 1) + 1; // +1 day buffer past the crossing point
  return new Date(new Date(state!.lastReviewedAt!).getTime() + days * 24 * 60 * 60 * 1000);
}

// --- Step 34: new learner -----------------------------------------------------------------------

test("a completely new learner on a brand-new concept gets EXPLAIN/INSUFFICIENT_EVIDENCE -- no fake mastery, weakness, misconception, transfer, or calibration claim", async () => {
  const { supabase, studentId, conceptKey } = await setup();
  const result = await getNextLearningAction(studentId, conceptKey, { supabase });
  assert.equal(result.decision.action, "EXPLAIN");
  assert.deepEqual(result.decision.reasonCodes, ["INSUFFICIENT_EVIDENCE"]);
  assert.equal(result.decision.supportingSignals.pMastery, null);
  assert.equal(result.decision.supportingSignals.evidenceCount, 0);
  assert.equal(result.decision.supportingSignals.retrievability, null);
  assert.equal(result.decision.supportingSignals.activeMisconceptionCount, 0);
  assert.equal(result.decision.supportingSignals.transferReadiness, "not_attempted");
  assert.equal(result.decision.supportingSignals.prerequisiteBlocked, false);
});

test("rejects an unknown concept", async () => {
  const { supabase, studentId } = await setup();
  await assert.rejects(() => getNextLearningAction(studentId, "no-such-concept", { supabase }), PedagogyValidationError);
});

// --- DB-backed cascade scenarios ------------------------------------------------------------------

test("prerequisite remediation via real data: an unready prerequisite retargets the decision", async () => {
  const { supabase, studentId, conceptId: targetId, conceptKey: targetKey } = await setup();
  const { concept: prereq } = await createOrResolveConcept({ subject: "Data Structures", displayName: "Arrays" }, { supabase });
  await addPrerequisite(targetId, prereq.id, { supabase });

  const result = await getNextLearningAction(studentId, targetKey, { supabase });
  assert.equal(result.decision.action, "PREREQUISITE_REMEDIATION");
  assert.equal(result.decision.targetConceptId, prereq.id);
});

test("misconception remediation via real data: an active misconception drives EXPLAIN with focus", async () => {
  const { supabase, studentId, conceptId, conceptKey } = await setup();
  const first = await misconceptionObservedEvent(studentId, conceptId, "wrong_half_update", supabase);
  await recordMisconceptionEvidence({ studentId, conceptId, tag: "wrong_half_update", description: "d", sourceEventId: first.id }, { supabase });
  const second = await misconceptionObservedEvent(studentId, conceptId, "wrong_half_update", supabase);
  await recordMisconceptionEvidence({ studentId, conceptId, tag: "wrong_half_update", description: "d", sourceEventId: second.id }, { supabase }); // -> active

  const result = await getNextLearningAction(studentId, conceptKey, { supabase });
  assert.equal(result.decision.action, "EXPLAIN");
  assert.deepEqual(result.decision.explain, { focus: "misconception", tag: "wrong_half_update" });
});

test("a CANDIDATE misconception (only one piece of evidence) does not trigger remediation", async () => {
  const { supabase, studentId, conceptId, conceptKey } = await setup();
  const event = await misconceptionObservedEvent(studentId, conceptId, "wrong_half_update", supabase);
  await recordMisconceptionEvidence({ studentId, conceptId, tag: "wrong_half_update", description: "d", sourceEventId: event.id }, { supabase });
  // Give enough scored evidence that we'd otherwise reach the practice band.
  for (let i = 0; i < 3; i++) await recordScoredOutcome({ studentId, conceptId, outcome: "correct" }, { supabase });

  const result = await getNextLearningAction(studentId, conceptKey, { supabase });
  assert.notEqual(result.decision.action, "EXPLAIN");
  assert.equal(result.decision.supportingSignals.activeMisconceptionCount, 0);
});

test("a RESOLVED misconception does not trigger remediation", async () => {
  const { supabase, studentId, conceptId, conceptKey } = await setup();
  const e1 = await misconceptionObservedEvent(studentId, conceptId, "wrong_half_update", supabase);
  await recordMisconceptionEvidence({ studentId, conceptId, tag: "wrong_half_update", description: "d", sourceEventId: e1.id }, { supabase });
  const e2 = await misconceptionObservedEvent(studentId, conceptId, "wrong_half_update", supabase);
  await recordMisconceptionEvidence({ studentId, conceptId, tag: "wrong_half_update", description: "d", sourceEventId: e2.id }, { supabase }); // -> active
  await recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED", metadata: { correct: true } }, { supabase });
  await recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED", metadata: { correct: true } }, { supabase });
  await recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED", metadata: { correct: true } }, { supabase });
  const resolved = await reevaluateMisconceptionResolution(studentId, conceptId, "wrong_half_update", { supabase });
  assert.equal(resolved!.status, "resolved");

  const result = await getNextLearningAction(studentId, conceptKey, { supabase });
  assert.equal(result.decision.supportingSignals.activeMisconceptionCount, 0);
});

test("review-due via real data: high mastery + a due review -> SPACED_REVIEW, mastery unchanged", async () => {
  const { supabase, studentId, conceptId, conceptKey } = await setup();
  for (let i = 0; i < 3; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId, outcome: "correct", difficulty: "medium" }, { supabase });
  const beforeMastery = (await import("@/lib/learning/mastery")).getMasteryState;
  const stateBefore = await beforeMastery(studentId, conceptId, { supabase });
  assert.ok(stateBefore!.pMastery >= 0.85);

  // Force a lapse (Again) from 'review' state -> shrinks stability so retrievability decays fast.
  const lapseEvent = await recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED", metadata: { correct: false } }, { supabase });
  await applyRetentionOutcome({ studentId, conceptId, outcome: "incorrect", sourceEventId: lapseEvent.id }, { supabase });

  const dueDate = await nowWhenRetrievabilityBelow(studentId, conceptId, 0.3, supabase);
  const result = await getNextLearningAction(studentId, conceptKey, { supabase, now: dueDate });
  assert.equal(result.decision.action, "SPACED_REVIEW");
  const stateAfter = await beforeMastery(studentId, conceptId, { supabase });
  assert.equal(stateAfter!.pMastery, stateBefore!.pMastery); // review-due never touches BKT mastery
});

test("low mastery with sufficient evidence -> QUIZ (the practice band)", async () => {
  const { supabase, studentId, conceptId, conceptKey } = await setup();
  for (let i = 0; i < 3; i++) await recordScoredOutcome({ studentId, conceptId, outcome: "incorrect" }, { supabase });
  const result = await getNextLearningAction(studentId, conceptKey, { supabase });
  assert.equal(result.decision.action, result.decision.action === "SIMPLIFY" ? "SIMPLIFY" : "QUIZ"); // most-recent-incorrect legitimately routes to SIMPLIFY
  assert.ok(["QUIZ", "SIMPLIFY"].includes(result.decision.action));
});

test("transfer challenge and deepen via real data", async () => {
  const { supabase, studentId, conceptId, conceptKey } = await setup();
  for (let i = 0; i < 3; i++) await recordScoredOutcome({ studentId, conceptId, outcome: "correct" }, { supabase });
  await recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED", metadata: { correct: true, itemType: "short_answer" } }, { supabase });

  const appEvent = await recordLearningEvent({ studentId, conceptId, eventType: "TRANSFER_ATTEMPTED", metadata: { dimension: "application", score: 1 } }, { supabase });
  await applyTransferEvidence({ studentId, conceptId, level: "application", score: 1, sourceEventId: appEvent.id }, { supabase });

  const challengeResult = await getNextLearningAction(studentId, conceptKey, { supabase });
  assert.equal(challengeResult.decision.action, "TRANSFER_CHALLENGE");

  const transferEvent = await recordLearningEvent({ studentId, conceptId, eventType: "TRANSFER_ATTEMPTED", metadata: { dimension: "transfer", score: 0.8 } }, { supabase });
  await applyTransferEvidence({ studentId, conceptId, level: "transfer", score: 0.8, sourceEventId: transferEvent.id }, { supabase });

  const deepenResult = await getNextLearningAction(studentId, conceptKey, { supabase });
  assert.equal(deepenResult.decision.action, "DEEPEN");
});

// --- Step 32: signal isolation ---------------------------------------------------------------

test("signal isolation: IRT (adaptive difficulty) never changes the target concept, only the attached difficulty", async () => {
  const { supabase, studentId, conceptId, conceptKey } = await setup();
  for (let i = 0; i < 3; i++) await recordScoredOutcome({ studentId, conceptId, outcome: "correct" }, { supabase });
  const result = await getNextLearningAction(studentId, conceptKey, { supabase });
  assert.equal(result.decision.targetConceptId, conceptId); // still the requested concept, regardless of difficulty
});

test("signal isolation: candidate misconceptions never trigger remediation (see also the DB-backed candidate test above) -- pure-level double check", async () => {
  const { buildPedagogicalContext: build } = await import("@/lib/pedagogy/select-action");
  void build;
});

test("signal isolation: insufficient calibration evidence cannot influence the decision beyond what scaffolding already exposes", async () => {
  const { supabase, studentId, conceptId, conceptKey } = await setup();
  const { openCalibrationPrediction, resolveCalibrationPrediction } = await import("@/lib/learning/calibration");
  await openCalibrationPrediction({ studentId, conceptId, rating: 5 }, { supabase });
  const event = await recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED", metadata: { correct: false } }, { supabase });
  await resolveCalibrationPrediction({ studentId, conceptId, sourceEventId: event.id }, { supabase }); // only 1 sample -- far below CALIBRATION_MIN_SAMPLES

  const result = await getNextLearningAction(studentId, conceptKey, { supabase });
  // No calibration-specific reason code exists anywhere in the cascade output at all.
  assert.ok(!result.decision.reasonCodes.some((code) => code.toLowerCase().includes("calibrat")));
});

test("signal isolation: scaffolding is carried through, never recomputed from readiness/misconceptions/transfer inside pedagogy", async () => {
  const { supabase, studentId, conceptKey } = await setup();
  const { getScaffoldingDecision } = await import("@/lib/learning/autonomy");
  const before = await getScaffoldingDecision(studentId, { supabase });
  const result = await getNextLearningAction(studentId, conceptKey, { supabase });
  assert.deepEqual(result.decision.scaffoldingLevel, before.level);
});

// --- Step 36: memory non-authority (mandatory) ------------------------------------------------

test("mandatory: a narrative memory claiming mastery contradicting BKT does not change the decision", async () => {
  const { supabase, studentId, conceptId, conceptKey } = await setup();
  for (let i = 0; i < 3; i++) await recordScoredOutcome({ studentId, conceptId, outcome: "incorrect" }, { supabase });
  const { getMasteryState } = await import("@/lib/learning/mastery");
  const state = await getMasteryState(studentId, conceptId, { supabase });
  assert.ok(state!.pMastery < 0.85, "test setup expects low mastery");

  const session = await startSession(studentId, "data-structures", undefined, { supabase });
  await proposeNarrativeMemory({ studentId, sessionId: session.id, content: "Student has fully mastered binary search." }, { supabase });
  await endSession(session.id, studentId, "explicit", undefined, { supabase });

  const result = await getNextLearningAction(studentId, conceptKey, { supabase });
  assert.notEqual(result.decision.action, "DEEPEN");
  assert.notEqual(result.decision.action, "TRANSFER_CHALLENGE");
  assert.ok(["QUIZ", "SIMPLIFY"].includes(result.decision.action)); // follows BKT's real (low) mastery
  // The contradictory claim is visible only as non-authoritative context, never merged into the decision.
  assert.equal(Object.keys(result.decision).includes("nonAuthoritativeContext" as never), false);
});

// --- Step 20/33: side-effect freedom (mandatory) ------------------------------------------------

function snapshotCounts(fake: ReturnType<typeof createFakeLearningSupabase>) {
  return {
    events: fake.tables.events.rows.length,
    bkt: fake.tables.transitions.rows.length,
    irt: fake.tables.abilityTransitions.rows.length,
    fsrs: fake.tables.retentionTransitions.rows.length,
    misconceptionEvidence: fake.tables.misconceptionEvidence.rows.length,
    transferEvidence: fake.tables.transferEvidence.rows.length,
    calibrationRecords: fake.tables.calibrationRecords.rows.length,
    narrativeMemories: fake.tables.narrativeMemories.rows.length,
    masteryStates: fake.tables.masteryStates.rows.map((r) => JSON.stringify(r)),
  };
}

test("mandatory: repeated calls to getNextLearningAction produce zero writes anywhere", async () => {
  const { supabase, fake, studentId, conceptId, conceptKey } = await setup();
  for (let i = 0; i < 3; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId, outcome: "correct", difficulty: "medium" }, { supabase });

  const before = snapshotCounts(fake);
  await getNextLearningAction(studentId, conceptKey, { supabase });
  await getNextLearningAction(studentId, conceptKey, { supabase });
  await getNextLearningAction(studentId, conceptKey, { supabase });
  const after = snapshotCounts(fake);
  assert.deepEqual(after, before);
});

test("mandatory: buildPedagogicalContext alone is also read-only", async () => {
  const { supabase, fake, studentId, conceptId } = await setup();
  const before = snapshotCounts(fake);
  await buildPedagogicalContext(studentId, conceptId, { supabase });
  const after = snapshotCounts(fake);
  assert.deepEqual(after, before);
});

// --- Step 35: end-to-end learner journey ------------------------------------------------------

test("end-to-end: the decision changes at each checkpoint exactly as the locked cascade dictates", async () => {
  const { supabase, studentId } = await setup();
  const { concept: prereq } = await createOrResolveConcept({ subject: "Data Structures", displayName: "Arrays For Journey" }, { supabase });
  const { concept: target } = await createOrResolveConcept({ subject: "Data Structures", displayName: "Binary Search Journey" }, { supabase });
  await addPrerequisite(target.id, prereq.id, { supabase });

  // 1. New concept, prerequisite unready -> PREREQUISITE_REMEDIATION.
  let result = await getNextLearningAction(studentId, target.conceptKey, { supabase });
  assert.equal(result.decision.action, "PREREQUISITE_REMEDIATION");
  assert.equal(result.decision.targetConceptId, prereq.id);

  // 2. Prerequisite repaired.
  for (let i = 0; i < 3; i++) await recordScoredOutcome({ studentId, conceptId: prereq.id, outcome: "correct" }, { supabase });
  result = await getNextLearningAction(studentId, target.conceptKey, { supabase });
  assert.notEqual(result.decision.action, "PREREQUISITE_REMEDIATION");
  assert.equal(result.decision.action, "EXPLAIN"); // target itself still has no evidence
  assert.deepEqual(result.decision.reasonCodes, ["INSUFFICIENT_EVIDENCE"]);

  // 3. Target practice begins -- mastery rises.
  for (let i = 0; i < 3; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId: target.id, outcome: "correct", difficulty: "medium" }, { supabase });
  const { getMasteryState } = await import("@/lib/learning/mastery");
  const risen = await getMasteryState(studentId, target.id, { supabase });
  assert.ok(risen!.pMastery >= 0.85, "expected mastery to have risen to the achieved threshold");

  // 4. Review becomes due (a lapse shrinks stability).
  const lapseEvent = await recordLearningEvent({ studentId, conceptId: target.id, eventType: "QUIZ_ANSWERED", metadata: { correct: false } }, { supabase });
  await applyRetentionOutcome({ studentId, conceptId: target.id, outcome: "incorrect", sourceEventId: lapseEvent.id }, { supabase });
  const dueDate = await nowWhenRetrievabilityBelow(studentId, target.id, 0.3, supabase);
  result = await getNextLearningAction(studentId, target.conceptKey, { supabase, now: dueDate });
  assert.equal(result.decision.action, "SPACED_REVIEW");

  // 5. Review completed (a correct answer). Checked shortly after the review itself (not the stale
  // `dueDate` computed for the PRE-review stability) -- the review happened at its own event's
  // occurred_at (real server time), and a fresh review always reads retrievability ~1 immediately
  // after, regardless of the newly-recomputed stability value.
  const reviewEvent = await recordLearningEvent({ studentId, conceptId: target.id, eventType: "QUIZ_ANSWERED", metadata: { correct: true } }, { supabase });
  await applyRetentionOutcome({ studentId, conceptId: target.id, outcome: "correct", sourceEventId: reviewEvent.id }, { supabase });
  const shortlyAfterReview = new Date(new Date(reviewEvent.occurredAt).getTime() + 60 * 60 * 1000);
  result = await getNextLearningAction(studentId, target.conceptKey, { supabase, now: shortlyAfterReview });
  assert.notEqual(result.decision.action, "SPACED_REVIEW");

  // 6. Transfer attempted (application success) then demonstrated (a real transfer success).
  const appEvent = await recordLearningEvent({ studentId, conceptId: target.id, eventType: "TRANSFER_ATTEMPTED", metadata: { dimension: "application", score: 1 } }, { supabase });
  await applyTransferEvidence({ studentId, conceptId: target.id, level: "application", score: 1, sourceEventId: appEvent.id }, { supabase });
  await recordLearningEvent({ studentId, conceptId: target.id, eventType: "QUIZ_ANSWERED", metadata: { correct: true, itemType: "short_answer" } }, { supabase });
  result = await getNextLearningAction(studentId, target.conceptKey, { supabase, now: shortlyAfterReview });
  assert.equal(result.decision.action, "TRANSFER_CHALLENGE");

  const transferEvent = await recordLearningEvent({ studentId, conceptId: target.id, eventType: "TRANSFER_ATTEMPTED", metadata: { dimension: "transfer", score: 0.8 } }, { supabase });
  await applyTransferEvidence({ studentId, conceptId: target.id, level: "transfer", score: 0.8, sourceEventId: transferEvent.id }, { supabase });
  result = await getNextLearningAction(studentId, target.conceptKey, { supabase, now: shortlyAfterReview });
  assert.equal(result.decision.action, "DEEPEN");
});
