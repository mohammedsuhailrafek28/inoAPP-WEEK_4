import assert from "node:assert/strict";
import test from "node:test";
import { computeAutonomyScore, computeAutonomyTrend, decideScaffolding, getAutonomySnapshot, getScaffoldingDecision, shiftScaffoldingLevel } from "@/lib/learning/autonomy";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { startSession, endSession } from "@/lib/learning/sessions";
import { recordLearningEvent } from "@/lib/learning/events";
import { createOrResolveConcept } from "@/lib/learning/concepts";
import { recordScoredOutcome } from "@/lib/learning/mastery";
import { createFakeLearningSupabase } from "./support/fake-learning-db";

async function setup() {
  const fake = createFakeLearningSupabase();
  const supabase = fake as never;
  const profile = await getOrCreateDefaultProfile({ supabase });
  const { concept } = await createOrResolveConcept({ subject: "Algorithms", displayName: "Hashing" }, { supabase });
  return { supabase, fake, studentId: profile.id, conceptId: concept.id };
}

/** Starts a session, lets the caller populate it with events, then ends it. */
async function runSession(studentId: string, supabase: unknown, populate: (sessionId: string) => Promise<void>) {
  const session = await startSession(studentId, "algorithms", undefined, { supabase } as never);
  await populate(session.id);
  return endSession(session.id, studentId, "explicit", undefined, { supabase } as never);
}

// --- Pure functions --------------------------------------------------------------------------

test("computeAutonomyScore: §15's exact four-component average", () => {
  const score = computeAutonomyScore({ initiativeRate: 1, calibrationAccuracy: 0.5, hintIndependence: 0.5, proactiveReviewRate: 0 });
  assert.equal(score, 0.5);
});

test("computeAutonomyTrend: fewer than 6 scores -> stable", () => {
  assert.equal(computeAutonomyTrend([0.9, 0.9, 0.9, 0.9, 0.9]), "stable");
});

test("computeAutonomyTrend: newest-5 mean meaningfully higher than prior -> improving", () => {
  // prior (up to 5, here just 1): [0.3]; newest 5: [0.9,0.9,0.9,0.9,0.9] -- diff way over 0.05
  assert.equal(computeAutonomyTrend([0.3, 0.9, 0.9, 0.9, 0.9, 0.9]), "improving");
});

test("computeAutonomyTrend: newest-5 mean meaningfully lower than prior -> declining", () => {
  assert.equal(computeAutonomyTrend([0.9, 0.3, 0.3, 0.3, 0.3, 0.3]), "declining");
});

test("computeAutonomyTrend: small difference within tolerance -> stable", () => {
  assert.equal(computeAutonomyTrend([0.5, 0.5, 0.5, 0.5, 0.5, 0.51]), "stable");
});

test("shiftScaffoldingLevel clamps at both ends", () => {
  assert.equal(shiftScaffoldingLevel("LOW_SUPPORT", "improving"), "LOW_SUPPORT");
  assert.equal(shiftScaffoldingLevel("HIGH_SUPPORT", "declining"), "HIGH_SUPPORT");
  assert.equal(shiftScaffoldingLevel("STANDARD", "improving"), "LOW_SUPPORT");
  assert.equal(shiftScaffoldingLevel("STANDARD", "declining"), "HIGH_SUPPORT");
  assert.equal(shiftScaffoldingLevel("STANDARD", "stable"), "STANDARD");
});

test("decideScaffolding: §15's exact tier bounds (0.3/0.7) before any trend shift", () => {
  assert.equal(decideScaffolding(0.1, "stable").level, "HIGH_SUPPORT");
  assert.equal(decideScaffolding(0.29, "stable").level, "HIGH_SUPPORT");
  assert.equal(decideScaffolding(0.3, "stable").level, "STANDARD");
  assert.equal(decideScaffolding(0.69, "stable").level, "STANDARD");
  assert.equal(decideScaffolding(0.7, "stable").level, "LOW_SUPPORT");
  assert.equal(decideScaffolding(1, "stable").level, "LOW_SUPPORT");
});

test("decideScaffolding: a trend shift is reported with an interpretable reason and a preserved base level", () => {
  const declining = decideScaffolding(0.5, "declining"); // STANDARD base, shifted toward HIGH_SUPPORT
  assert.equal(declining.baseLevel, "STANDARD");
  assert.equal(declining.level, "HIGH_SUPPORT");
  assert.ok(declining.reasonCodes.includes("TREND_SHIFTED_DOWN"));

  const improving = decideScaffolding(0.5, "improving");
  assert.equal(improving.level, "LOW_SUPPORT");
  assert.ok(improving.reasonCodes.includes("TREND_SHIFTED_UP"));

  const stable = decideScaffolding(0.5, "stable");
  assert.equal(stable.level, stable.baseLevel);
  assert.ok(!stable.reasonCodes.some((code) => code.startsWith("TREND_SHIFTED")));
});

// --- DB-backed: evidence gating -------------------------------------------------------------

test("insufficient evidence: fewer than MIN_EVIDENCE_FOR_ADAPTIVE scored sessions pins scaffolding to STANDARD with an explicit reason", async () => {
  const { supabase, studentId } = await setup();
  const decision = await getScaffoldingDecision(studentId, { supabase });
  assert.equal(decision.evidenceSufficient, false);
  assert.equal(decision.level, "STANDARD");
  assert.deepEqual(decision.reasonCodes, ["INSUFFICIENT_EVIDENCE"]);
  assert.equal(decision.autonomy, null);
});

// --- DB-backed: components ---------------------------------------------------------------------

test("initiativeRate reflects the self-initiated fraction of QUESTION_ASKED events in a session", async () => {
  const { supabase, studentId } = await setup();
  await runSession(studentId, supabase, async (sessionId) => {
    await recordLearningEvent({ studentId, sessionId, eventType: "QUESTION_ASKED", metadata: { selfInitiated: true } }, { supabase });
    await recordLearningEvent({ studentId, sessionId, eventType: "QUESTION_ASKED", metadata: { selfInitiated: false } }, { supabase });
  });
  const snapshot = await getAutonomySnapshot(studentId, { supabase });
  assert.equal(snapshot!.components.initiativeRate, 0.5);
});

test("hintIndependence: hints on an already-mastered concept reduce independence; hints on a not-yet-mastered concept don't count", async () => {
  const { supabase, studentId, conceptId } = await setup();
  for (let i = 0; i < 3; i++) await recordScoredOutcome({ studentId, conceptId, outcome: "correct" }, { supabase });

  const { concept: unmastered } = await createOrResolveConcept({ subject: "Algorithms", displayName: "Recursion" }, { supabase });

  await runSession(studentId, supabase, async (sessionId) => {
    await recordLearningEvent({ studentId, sessionId, conceptId, eventType: "QUIZ_ANSWERED", metadata: { correct: true } }, { supabase });
    await recordLearningEvent({ studentId, sessionId, conceptId, eventType: "HINT_REQUESTED" }, { supabase }); // on a mastered concept -- counts
    await recordLearningEvent({ studentId, sessionId, conceptId: unmastered.id, eventType: "HINT_REQUESTED" }, { supabase }); // not mastered -- excluded
  });

  const snapshot = await getAutonomySnapshot(studentId, { supabase });
  // 1 hint out of 2 relevant interactions (the correct answer + the hint) on the mastered concept.
  assert.equal(snapshot!.components.hintIndependence, 0.5);
});

test("proactiveReviewRate: a review completed before its own due date counts as proactive", async () => {
  const { supabase, fake, studentId, conceptId } = await setup();
  const { recordScoredOutcomeWithRetention } = await import("@/lib/learning/reviews");

  const session = await startSession(studentId, "algorithms", undefined, { supabase });
  await recordScoredOutcomeWithRetention({ studentId, sessionId: session.id, conceptId, outcome: "correct", difficulty: "medium" }, { supabase });
  // Force the second review's reviewed_at to be safely before the first transition's next_review_at.
  const secondEvent = await recordLearningEvent({ studentId, sessionId: session.id, conceptId, eventType: "QUIZ_ANSWERED", metadata: { correct: true } }, { supabase });
  const { applyRetentionOutcome } = await import("@/lib/learning/reviews");
  await applyRetentionOutcome({ studentId, conceptId, outcome: "correct", sourceEventId: secondEvent.id }, { supabase });
  await endSession(session.id, studentId, "explicit", undefined, { supabase });

  const transitions = fake.tables.retentionTransitions.rows.filter((row) => row.concept_id === conceptId);
  assert.equal(transitions.length, 2); // sanity: both reviews landed

  const snapshot = await getAutonomySnapshot(studentId, { supabase });
  assert.equal(snapshot!.components.proactiveReviewRate, 1); // the second review happened immediately, well before its predecessor's next_review_at
});

test("trend requires >=6 historical (session-level) scores -- fewer sessions means 'stable'", async () => {
  const { supabase, studentId, conceptId } = await setup();
  for (let i = 0; i < 3; i++) {
    await runSession(studentId, supabase, async (sessionId) => {
      await recordScoredOutcome({ studentId, conceptId, outcome: "correct" }, { supabase });
      await recordLearningEvent({ studentId, sessionId, eventType: "QUESTION_ASKED", metadata: { selfInitiated: true } }, { supabase });
    });
  }
  const snapshot = await getAutonomySnapshot(studentId, { supabase });
  assert.ok(snapshot!.historicalScoreCount < 6);
  assert.equal(snapshot!.trend, "stable");
});

test("scaffolding decision does not directly consume BKT mastery, misconceptions, readiness, or transfer -- only the four locked §15 components (via calibration/hints/reviews)", async () => {
  const { supabase, studentId, conceptId } = await setup();
  // Drive mastery to a very low value and create an active misconception -- neither should appear
  // anywhere in the autonomy/scaffolding output, since §15's formula has no such input.
  for (let i = 0; i < 3; i++) await recordScoredOutcome({ studentId, conceptId, outcome: "incorrect" }, { supabase });

  for (let i = 0; i < 6; i++) {
    await runSession(studentId, supabase, async (sessionId) => {
      await recordLearningEvent({ studentId, sessionId, eventType: "QUESTION_ASKED", metadata: { selfInitiated: true } }, { supabase });
    });
  }
  const decision = await getScaffoldingDecision(studentId, { supabase });
  assert.deepEqual(Object.keys(decision.autonomy!.components).sort(), ["calibrationAccuracy", "hintIndependence", "initiativeRate", "proactiveReviewRate"].sort());
});
