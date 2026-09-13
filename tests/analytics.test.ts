import assert from "node:assert/strict";
import test from "node:test";
import { getSubjectAnalytics } from "@/lib/learning/analytics";
import { createFakeLearningSupabase } from "./support/fake-learning-db";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { createOrResolveConcept } from "@/lib/learning/concepts";
import { recordScoredOutcomeWithRetention } from "@/lib/learning/reviews";
import { openCalibrationPrediction, resolveCalibrationPrediction } from "@/lib/learning/calibration";
import { recordLearningEvent } from "@/lib/learning/events";

async function setup(subject = "Analytics Subject") {
  const fake = createFakeLearningSupabase();
  const supabase = fake as never;
  const profile = await getOrCreateDefaultProfile({ supabase });
  return { supabase, fake, studentId: profile.id, subject };
}

test("Step 25/26: subject analytics counts concepts by stage, never conflating 'registered' with 'assessed'", async () => {
  const { supabase, studentId, subject } = await setup();
  await createOrResolveConcept({ subject, displayName: "Untouched" }, { supabase }); // registered, zero evidence
  const { concept: touched } = await createOrResolveConcept({ subject, displayName: "Touched" }, { supabase });
  await recordScoredOutcomeWithRetention({ studentId, conceptId: touched.id, outcome: "correct", difficulty: "medium" }, { supabase });

  const analytics = await getSubjectAnalytics(studentId, subject, { supabase });
  assert.equal(analytics.stageCounts.NEW, 1);
  assert.equal(analytics.conceptsAssessed, 1); // only the touched concept
  assert.equal(analytics.concepts.length, 2);
});

test("Step 49: calibration visibility -- below 5 samples is insufficient_evidence, at 5 it's reportable", async () => {
  const { supabase, studentId, subject } = await setup();
  const { concept } = await createOrResolveConcept({ subject, displayName: "C" }, { supabase });

  for (let i = 0; i < 4; i++) {
    await openCalibrationPrediction({ studentId, conceptId: concept.id, rating: 5 }, { supabase }); // predicted = 1.0
    const event = await recordLearningEvent({ studentId, conceptId: concept.id, eventType: "QUIZ_ANSWERED", metadata: { correct: false } }, { supabase });
    await resolveCalibrationPrediction({ studentId, conceptId: concept.id, sourceEventId: event.id }, { supabase }); // actual = 0
  }
  const belowThreshold = await getSubjectAnalytics(studentId, subject, { supabase });
  assert.equal(belowThreshold.calibration.state, "insufficient_evidence");

  await openCalibrationPrediction({ studentId, conceptId: concept.id, rating: 5 }, { supabase });
  const event5 = await recordLearningEvent({ studentId, conceptId: concept.id, eventType: "QUIZ_ANSWERED", metadata: { correct: false } }, { supabase });
  await resolveCalibrationPrediction({ studentId, conceptId: concept.id, sourceEventId: event5.id }, { supabase });
  const atThreshold = await getSubjectAnalytics(studentId, subject, { supabase });
  assert.notEqual(atThreshold.calibration.state, "insufficient_evidence");
  assert.equal(atThreshold.calibration.state, "overconfident"); // predicted 0.9, actual always 0
});

test("transfer coverage: ready count is always <= mastered count, both zero for a fresh subject", async () => {
  const { supabase, studentId, subject } = await setup();
  const analytics = await getSubjectAnalytics(studentId, subject, { supabase });
  assert.equal(analytics.transferCoverage.masteredCount, 0);
  assert.equal(analytics.transferCoverage.readyCount, 0);
});

test("Step 30/31: quiz evidence-trust is preserved, never blended -- deterministic and llm_graded counted separately", async () => {
  const { supabase, fake, studentId, subject } = await setup();
  const { concept } = await createOrResolveConcept({ subject, displayName: "C" }, { supabase });
  const quiz = { id: "quiz-1", student_id: studentId, session_id: null, subject, action: "QUIZ", target_concept_id: concept.id, difficulty: "medium", status: "submitted", score: 1, submitted_at: new Date().toISOString() };
  fake.tables.quizzes.rows.push(quiz);
  const event = await recordLearningEvent({ studentId, conceptId: concept.id, eventType: "QUIZ_ANSWERED", metadata: { correct: true } }, { supabase });
  fake.tables.quizAnswers.rows.push({ id: "a1", quiz_id: "quiz-1", question_id: "q1", student_id: studentId, submitted_answer: "x", correct: true, score: 1, evidence_trust: "deterministic", source_event_id: event.id });
  const event2 = await recordLearningEvent({ studentId, conceptId: concept.id, eventType: "QUIZ_ANSWERED", metadata: { correct: false } }, { supabase });
  fake.tables.quizAnswers.rows.push({ id: "a2", quiz_id: "quiz-1", question_id: "q2", student_id: studentId, submitted_answer: "y", correct: false, score: 0, evidence_trust: "llm_graded", source_event_id: event2.id });

  const analytics = await getSubjectAnalytics(studentId, subject, { supabase });
  assert.deepEqual(analytics.quizEvidence.deterministic, { attempts: 1, correct: 1 });
  assert.deepEqual(analytics.quizEvidence.llmGraded, { attempts: 1, correct: 0 });
});

test("side-effect-free: repeated subject-analytics calls create zero new evidence/transitions", async () => {
  const { supabase, fake, studentId, subject } = await setup();
  const { concept } = await createOrResolveConcept({ subject, displayName: "C" }, { supabase });
  await recordScoredOutcomeWithRetention({ studentId, conceptId: concept.id, outcome: "correct", difficulty: "medium" }, { supabase });
  const before = { events: fake.tables.events.rows.length, transitions: fake.tables.transitions.rows.length };
  await getSubjectAnalytics(studentId, subject, { supabase });
  await getSubjectAnalytics(studentId, subject, { supabase });
  assert.equal(fake.tables.events.rows.length, before.events);
  assert.equal(fake.tables.transitions.rows.length, before.transitions);
});

test("determinism: identical DB state + injected now produces identical analytics", async () => {
  const { supabase, studentId, subject } = await setup();
  const { concept } = await createOrResolveConcept({ subject, displayName: "C" }, { supabase });
  await recordScoredOutcomeWithRetention({ studentId, conceptId: concept.id, outcome: "correct", difficulty: "medium" }, { supabase });
  const now = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const a = await getSubjectAnalytics(studentId, subject, { supabase, now });
  const b = await getSubjectAnalytics(studentId, subject, { supabase, now });
  assert.deepEqual(a, b);
});
