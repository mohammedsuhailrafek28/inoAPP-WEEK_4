import assert from "node:assert/strict";
import test from "node:test";
import { detectIntervention } from "@/lib/intervention/detect";
import { createFakeLearningSupabase } from "./support/fake-learning-db";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { createOrResolveConcept, addPrerequisite } from "@/lib/learning/concepts";
import { recordScoredOutcomeWithRetention } from "@/lib/learning/reviews";
import { recordLearningEvent } from "@/lib/learning/events";
import { recordMisconceptionEvidence } from "@/lib/learning/misconceptions";

async function setup() {
  const fake = createFakeLearningSupabase();
  const supabase = fake as never;
  const profile = await getOrCreateDefaultProfile({ supabase });
  return { supabase, fake, studentId: profile.id };
}

test("no intervention for a healthy (mastered, unblocked, no misconception) concept", async () => {
  const { supabase, studentId } = await setup();
  const { concept } = await createOrResolveConcept({ subject: "Healthy Subject", displayName: "Concept" }, { supabase });
  for (let i = 0; i < 6; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId: concept.id, outcome: "correct", difficulty: "medium" }, { supabase });

  const result = await detectIntervention(studentId, concept.id, { supabase });
  assert.equal(result.trigger, null);
  assert.deepEqual(result.reasonCodes, []);
});

test("no intervention for a never-touched concept (insufficient evidence is absence of evidence, not a struggle)", async () => {
  const { supabase, studentId } = await setup();
  const { concept } = await createOrResolveConcept({ subject: "Fresh Subject", displayName: "Concept" }, { supabase });
  const result = await detectIntervention(studentId, concept.id, { supabase });
  assert.equal(result.trigger, null);
});

test("MASTERY_GAP for a concept with sufficient evidence but developing mastery", async () => {
  const { supabase, studentId } = await setup();
  const { concept } = await createOrResolveConcept({ subject: "Developing Subject", displayName: "Concept" }, { supabase });
  for (let i = 0; i < 3; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId: concept.id, outcome: "incorrect", difficulty: "medium" }, { supabase });

  const result = await detectIntervention(studentId, concept.id, { supabase });
  assert.equal(result.trigger, "MASTERY_GAP");
  assert.deepEqual(result.reasonCodes, ["MASTERY_DEVELOPING"]);
  assert.equal(result.blocker, null);
  assert.equal(result.misconception, null);
});

test("ACTIVE_MISCONCEPTION takes priority over a mere developing-mastery signal", async () => {
  const { supabase, studentId } = await setup();
  const { concept } = await createOrResolveConcept({ subject: "Misconception Subject", displayName: "Concept" }, { supabase });
  await recordScoredOutcomeWithRetention({ studentId, conceptId: concept.id, outcome: "incorrect", difficulty: "medium" }, { supabase });

  for (let i = 0; i < 2; i++) {
    const quizEvent = await recordLearningEvent({ studentId, conceptId: concept.id, eventType: "QUIZ_ANSWERED", metadata: { correct: false } }, { supabase });
    const observed = await recordLearningEvent({ studentId, conceptId: concept.id, eventType: "MISCONCEPTION_OBSERVED", metadata: { proposedByLlm: true, relatedEventId: quizEvent.id, tag: "off-by-one" } }, { supabase });
    await recordMisconceptionEvidence({ studentId, conceptId: concept.id, sourceEventId: observed.id, tag: "off-by-one", description: "an off-by-one boundary error" }, { supabase });
  }

  const result = await detectIntervention(studentId, concept.id, { supabase });
  assert.equal(result.trigger, "ACTIVE_MISCONCEPTION");
  assert.deepEqual(result.reasonCodes, ["ACTIVE_MISCONCEPTION"]);
  assert.equal(result.misconception?.tag, "off_by_one"); // normalizeMisconceptionTag() converts hyphens to underscores
  assert.equal(result.misconception?.description, "an off-by-one boundary error");
});

test("PREREQUISITE_GAP takes priority over both an active misconception and developing mastery", async () => {
  const { supabase, studentId } = await setup();
  const { concept: prereq } = await createOrResolveConcept({ subject: "Prereq Priority Subject", displayName: "Prereq" }, { supabase });
  const { concept: target } = await createOrResolveConcept({ subject: "Prereq Priority Subject", displayName: "Target" }, { supabase });
  await addPrerequisite(target.id, prereq.id, { supabase });
  // Give the target its own misconception AND weak mastery -- prerequisite gap must still win.
  await recordScoredOutcomeWithRetention({ studentId, conceptId: target.id, outcome: "incorrect", difficulty: "medium" }, { supabase });
  for (let i = 0; i < 2; i++) {
    const quizEvent = await recordLearningEvent({ studentId, conceptId: target.id, eventType: "QUIZ_ANSWERED", metadata: { correct: false } }, { supabase });
    const observed = await recordLearningEvent({ studentId, conceptId: target.id, eventType: "MISCONCEPTION_OBSERVED", metadata: { proposedByLlm: true, relatedEventId: quizEvent.id, tag: "t" } }, { supabase });
    await recordMisconceptionEvidence({ studentId, conceptId: target.id, sourceEventId: observed.id, tag: "t", description: "d" }, { supabase });
  }

  const result = await detectIntervention(studentId, target.id, { supabase });
  assert.equal(result.trigger, "PREREQUISITE_GAP");
  assert.equal(result.blocker?.conceptKey, prereq.conceptKey);
  assert.equal(result.blocker?.reasonCode, "PREREQUISITE_NO_EVIDENCE"); // prereq has zero evidence at all
});

test("the correct blocker concept is returned, not merely 'some' blocker", async () => {
  const { supabase, studentId } = await setup();
  const { concept: prereqA } = await createOrResolveConcept({ subject: "Chain Subject", displayName: "Alpha" }, { supabase });
  const { concept: prereqB } = await createOrResolveConcept({ subject: "Chain Subject", displayName: "Beta" }, { supabase });
  const { concept: target } = await createOrResolveConcept({ subject: "Chain Subject", displayName: "Gamma" }, { supabase });
  await addPrerequisite(prereqB.id, prereqA.id, { supabase }); // Beta requires Alpha
  await addPrerequisite(target.id, prereqB.id, { supabase }); // Gamma requires Beta
  for (let i = 0; i < 3; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId: target.id, outcome: "incorrect", difficulty: "medium" }, { supabase });

  const result = await detectIntervention(studentId, target.id, { supabase });
  assert.equal(result.trigger, "PREREQUISITE_GAP");
  // Gamma's own DIRECT prerequisite is Beta, not Alpha -- readiness classifies direct prerequisites only.
  assert.equal(result.blocker?.conceptKey, prereqB.conceptKey);
});

test("determinism: identical learner state produces an identical detection result", async () => {
  const { supabase, studentId } = await setup();
  const { concept } = await createOrResolveConcept({ subject: "Deterministic Subject", displayName: "Concept" }, { supabase });
  for (let i = 0; i < 3; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId: concept.id, outcome: "incorrect", difficulty: "medium" }, { supabase });

  const now = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const first = await detectIntervention(studentId, concept.id, { supabase, now });
  const second = await detectIntervention(studentId, concept.id, { supabase, now });
  assert.deepEqual(first, second);
});

test("a prerequisite that becomes ready changes the detection result (no stale verdict)", async () => {
  const { supabase, studentId } = await setup();
  const { concept: prereq } = await createOrResolveConcept({ subject: "Adaptive Subject", displayName: "Prereq" }, { supabase });
  const { concept: target } = await createOrResolveConcept({ subject: "Adaptive Subject", displayName: "Target" }, { supabase });
  await addPrerequisite(target.id, prereq.id, { supabase });
  for (let i = 0; i < 3; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId: target.id, outcome: "incorrect", difficulty: "medium" }, { supabase });

  const before = await detectIntervention(studentId, target.id, { supabase });
  assert.equal(before.trigger, "PREREQUISITE_GAP");

  // The prerequisite becomes genuinely ready via the real trusted write path.
  for (let i = 0; i < 6; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId: prereq.id, outcome: "correct", difficulty: "medium" }, { supabase });

  const after = await detectIntervention(studentId, target.id, { supabase });
  assert.equal(after.trigger, "MASTERY_GAP"); // prerequisite gap clears; target's own developing mastery is now the remaining issue
});
