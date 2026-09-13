import assert from "node:assert/strict";
import test from "node:test";
import { generateIntervention, InterventionValidationError } from "@/lib/intervention/generate";
import { INTERVENTION_RECOVERY_BUDGET_MINUTES } from "@/lib/intervention/constants";
import { createFakeLearningSupabase } from "./support/fake-learning-db";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { createOrResolveConcept, addPrerequisite } from "@/lib/learning/concepts";
import { recordScoredOutcomeWithRetention } from "@/lib/learning/reviews";
import { listAgentActivity } from "@/lib/learning/agent-activity";
import { PLAN_ACTIVITY_DURATION_MINUTES } from "@/lib/plan/constants";

async function setup() {
  const fake = createFakeLearningSupabase();
  const supabase = fake as never;
  const profile = await getOrCreateDefaultProfile({ supabase });
  return { supabase, fake, studentId: profile.id };
}

test("NOT_NEEDED for a healthy concept -- empty recovery plan, no activity logged", async () => {
  const { supabase, studentId } = await setup();
  const { concept } = await createOrResolveConcept({ subject: "Healthy Subject", displayName: "Concept" }, { supabase });
  for (let i = 0; i < 6; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId: concept.id, outcome: "correct", difficulty: "medium" }, { supabase });

  const intervention = await generateIntervention(studentId, concept.conceptKey, { supabase });
  assert.equal(intervention.status, "NOT_NEEDED");
  assert.equal(intervention.trigger, null);
  assert.deepEqual(intervention.recoveryItems, []);

  const activity = await listAgentActivity(studentId, { subject: "healthy-subject" }, { supabase });
  assert.equal(activity.length, 0);
});

test("PREREQUISITE_GAP recovery: learn blocker, practice blocker, recheck target -- in that order, prerequisite-first", async () => {
  const { supabase, studentId } = await setup();
  const { concept: prereq } = await createOrResolveConcept({ subject: "Recovery Subject", displayName: "Rolling Hash" }, { supabase });
  const { concept: target } = await createOrResolveConcept({ subject: "Recovery Subject", displayName: "Rabin-Karp" }, { supabase });
  await addPrerequisite(target.id, prereq.id, { supabase });
  for (let i = 0; i < 3; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId: target.id, outcome: "incorrect", difficulty: "medium" }, { supabase });

  const intervention = await generateIntervention(studentId, target.conceptKey, { supabase });
  assert.equal(intervention.status, "ACTIVE");
  assert.equal(intervention.trigger, "PREREQUISITE_GAP");
  assert.equal(intervention.blocker?.conceptKey, prereq.conceptKey);
  assert.match(intervention.why, /Rabin-Karp/);
  assert.match(intervention.why, /Rolling Hash/);
  assert.match(intervention.why, /likely|not yet ready|recommended/i);

  assert.equal(intervention.recoveryItems.length, 3);
  assert.equal(intervention.recoveryItems[0].conceptKey, prereq.conceptKey);
  assert.equal(intervention.recoveryItems[0].activityType, "learn");
  assert.equal(intervention.recoveryItems[1].conceptKey, prereq.conceptKey);
  assert.equal(intervention.recoveryItems[1].activityType, "practice");
  assert.equal(intervention.recoveryItems[2].conceptKey, target.conceptKey);
  assert.equal(intervention.recoveryItems[2].activityType, "practice");

  assert.equal(intervention.materialFocusConceptKey, prereq.conceptKey); // material actions target the BLOCKER, not the target, for a prerequisite gap
});

test("ACTIVE_MISCONCEPTION recovery targets the concept itself, single-item, material focus stays on the target", async () => {
  const { supabase, studentId } = await setup();
  const { concept } = await createOrResolveConcept({ subject: "Misconception Recovery Subject", displayName: "Concept" }, { supabase });
  await recordScoredOutcomeWithRetention({ studentId, conceptId: concept.id, outcome: "incorrect", difficulty: "medium" }, { supabase });
  const { recordLearningEvent } = await import("@/lib/learning/events");
  const { recordMisconceptionEvidence } = await import("@/lib/learning/misconceptions");
  for (let i = 0; i < 2; i++) {
    const quizEvent = await recordLearningEvent({ studentId, conceptId: concept.id, eventType: "QUIZ_ANSWERED", metadata: { correct: false } }, { supabase });
    const observed = await recordLearningEvent({ studentId, conceptId: concept.id, eventType: "MISCONCEPTION_OBSERVED", metadata: { proposedByLlm: true, relatedEventId: quizEvent.id, tag: "t" } }, { supabase });
    await recordMisconceptionEvidence({ studentId, conceptId: concept.id, sourceEventId: observed.id, tag: "t", description: "a recurring pattern" }, { supabase });
  }

  const intervention = await generateIntervention(studentId, concept.conceptKey, { supabase });
  assert.equal(intervention.trigger, "ACTIVE_MISCONCEPTION");
  assert.equal(intervention.recoveryItems.length, 1);
  assert.equal(intervention.recoveryItems[0].conceptKey, concept.conceptKey);
  assert.equal(intervention.materialFocusConceptKey, concept.conceptKey);
  assert.match(intervention.why, /recurring pattern/);
});

test("recovery budget is respected: total estimatedMinutes never exceeds INTERVENTION_RECOVERY_BUDGET_MINUTES", async () => {
  const { supabase, studentId } = await setup();
  const { concept: prereq } = await createOrResolveConcept({ subject: "Budget Subject", displayName: "Prereq" }, { supabase });
  const { concept: target } = await createOrResolveConcept({ subject: "Budget Subject", displayName: "Target" }, { supabase });
  await addPrerequisite(target.id, prereq.id, { supabase });
  for (let i = 0; i < 3; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId: target.id, outcome: "incorrect", difficulty: "medium" }, { supabase });

  const intervention = await generateIntervention(studentId, target.conceptKey, { supabase });
  const total = intervention.recoveryItems.reduce((sum, item) => sum + item.estimatedMinutes, 0);
  assert.ok(total <= INTERVENTION_RECOVERY_BUDGET_MINUTES);
  // The richest (PREREQUISITE_GAP) case is exactly learn+practice+practice from the existing duration policy.
  assert.equal(total, PLAN_ACTIVITY_DURATION_MINUTES.learn + PLAN_ACTIVITY_DURATION_MINUTES.practice + PLAN_ACTIVITY_DURATION_MINUTES.practice);
});

test("material actions (Notes/Flashcards) never mutate learner state -- generating an intervention twice in a row leaves mastery unchanged", async () => {
  const { supabase, studentId } = await setup();
  const { concept } = await createOrResolveConcept({ subject: "No Mutation Subject", displayName: "Concept" }, { supabase });
  for (let i = 0; i < 3; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId: concept.id, outcome: "incorrect", difficulty: "medium" }, { supabase });

  const { getMasteryState } = await import("@/lib/learning/mastery");
  const before = await getMasteryState(studentId, concept.id, { supabase });
  await generateIntervention(studentId, concept.conceptKey, { supabase });
  await generateIntervention(studentId, concept.conceptKey, { supabase }); // simulates opening the recovery view twice / viewing materials
  const after = await getMasteryState(studentId, concept.id, { supabase });
  assert.equal(before?.pMastery, after?.pMastery);
  assert.equal(before?.evidenceCount, after?.evidenceCount);
});

test("recheck against unchanged state is stable (same trigger, same blocker, same recovery plan shape)", async () => {
  const { supabase, studentId } = await setup();
  const { concept: prereq } = await createOrResolveConcept({ subject: "Stable Recheck Subject", displayName: "Prereq" }, { supabase });
  const { concept: target } = await createOrResolveConcept({ subject: "Stable Recheck Subject", displayName: "Target" }, { supabase });
  await addPrerequisite(target.id, prereq.id, { supabase });
  for (let i = 0; i < 3; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId: target.id, outcome: "incorrect", difficulty: "medium" }, { supabase });

  const now = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const first = await generateIntervention(studentId, target.conceptKey, { supabase, now });
  const second = await generateIntervention(studentId, target.conceptKey, { supabase, now, activityKind: "PLAN_REPLANNED" });
  assert.equal(first.trigger, second.trigger);
  assert.equal(first.blocker?.conceptKey, second.blocker?.conceptKey);
  assert.deepEqual(
    first.recoveryItems.map((i) => ({ conceptKey: i.conceptKey, activityType: i.activityType })),
    second.recoveryItems.map((i) => ({ conceptKey: i.conceptKey, activityType: i.activityType })),
  );
});

test("changed authoritative learner state changes the intervention -- clearing the blocker resolves the prerequisite gap", async () => {
  const { supabase, studentId } = await setup();
  const { concept: prereq } = await createOrResolveConcept({ subject: "Changing State Subject", displayName: "Prereq" }, { supabase });
  const { concept: target } = await createOrResolveConcept({ subject: "Changing State Subject", displayName: "Target" }, { supabase });
  await addPrerequisite(target.id, prereq.id, { supabase });
  for (let i = 0; i < 3; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId: target.id, outcome: "incorrect", difficulty: "medium" }, { supabase });

  const before = await generateIntervention(studentId, target.conceptKey, { supabase });
  assert.equal(before.trigger, "PREREQUISITE_GAP");

  for (let i = 0; i < 6; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId: prereq.id, outcome: "correct", difficulty: "medium" }, { supabase });

  const after = await generateIntervention(studentId, target.conceptKey, { supabase, activityKind: "PLAN_REPLANNED" });
  assert.notEqual(after.trigger, "PREREQUISITE_GAP");
});

test("an unknown conceptKey is a validation error, never an unhandled throw shape", async () => {
  const { supabase, studentId } = await setup();
  await assert.rejects(() => generateIntervention(studentId, "does-not-exist", { supabase }), InterventionValidationError);
});

test("a successful (ACTIVE) generation logs exactly one activity row tagged mode='intervention'", async () => {
  const { supabase, studentId } = await setup();
  const { concept: prereq } = await createOrResolveConcept({ subject: "Logged Intervention Subject", displayName: "Prereq" }, { supabase });
  const { concept: target } = await createOrResolveConcept({ subject: "Logged Intervention Subject", displayName: "Target" }, { supabase });
  await addPrerequisite(target.id, prereq.id, { supabase });
  for (let i = 0; i < 3; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId: target.id, outcome: "incorrect", difficulty: "medium" }, { supabase });

  await generateIntervention(studentId, target.conceptKey, { supabase });
  const activity = await listAgentActivity(studentId, { subject: "logged-intervention-subject" }, { supabase });
  assert.equal(activity.length, 1);
  assert.equal(activity[0].kind, "PLAN_GENERATED");
  assert.equal(activity[0].metadata.mode, "intervention");
  assert.equal(activity[0].metadata.trigger, "PREREQUISITE_GAP");
  assert.equal(activity[0].metadata.blockerConceptKey, prereq.conceptKey);
});

test("mirrors the real algorithms demo evidence pattern (hashing mastered, rolling-hash untouched, rabin-karp developing) and yields the expected prerequisite intervention", async () => {
  const { supabase, studentId } = await setup();
  const { concept: hashing } = await createOrResolveConcept({ subject: "algorithms", displayName: "Hashing" }, { supabase });
  const { concept: rollingHash } = await createOrResolveConcept({ subject: "algorithms", displayName: "Rolling Hash" }, { supabase });
  const { concept: rabinKarp } = await createOrResolveConcept({ subject: "algorithms", displayName: "Rabin-Karp" }, { supabase });
  await addPrerequisite(rollingHash.id, hashing.id, { supabase });
  await addPrerequisite(rabinKarp.id, rollingHash.id, { supabase });

  for (let i = 0; i < 5; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId: hashing.id, outcome: "correct", difficulty: "medium" }, { supabase });
  // rolling-hash: deliberately untouched -- the point of the prerequisite gap.
  for (let i = 0; i < 3; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId: rabinKarp.id, outcome: "incorrect", difficulty: "medium" }, { supabase });

  const intervention = await generateIntervention(studentId, rabinKarp.conceptKey, { supabase });
  assert.equal(intervention.status, "ACTIVE");
  assert.equal(intervention.trigger, "PREREQUISITE_GAP");
  assert.equal(intervention.targetConceptKey, "rabin-karp");
  assert.equal(intervention.blocker?.conceptKey, "rolling-hash");
  assert.equal(intervention.blocker?.reasonCode, "PREREQUISITE_NO_EVIDENCE");
  assert.equal(intervention.recoveryItems[0].conceptKey, "rolling-hash");
  assert.equal(intervention.recoveryItems[0].activityType, "learn");
});

test("recheck logs PLAN_REPLANNED instead of PLAN_GENERATED, still tagged mode='intervention'", async () => {
  const { supabase, studentId } = await setup();
  const { concept } = await createOrResolveConcept({ subject: "Recheck Logging Subject", displayName: "Concept" }, { supabase });
  for (let i = 0; i < 3; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId: concept.id, outcome: "incorrect", difficulty: "medium" }, { supabase });

  await generateIntervention(studentId, concept.conceptKey, { supabase });
  await generateIntervention(studentId, concept.conceptKey, { supabase, activityKind: "PLAN_REPLANNED" });

  const activity = await listAgentActivity(studentId, { subject: "recheck-logging-subject" }, { supabase });
  assert.equal(activity.length, 2);
  assert.equal(activity[0].kind, "PLAN_REPLANNED");
  assert.equal(activity[1].kind, "PLAN_GENERATED");
});
