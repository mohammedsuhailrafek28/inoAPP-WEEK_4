import assert from "node:assert/strict";
import test from "node:test";
import { replanLearningPlan } from "@/lib/plan/replan";
import { createFakeLearningSupabase } from "./support/fake-learning-db";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { createOrResolveConcept } from "@/lib/learning/concepts";
import { recordScoredOutcomeWithRetention } from "@/lib/learning/reviews";
import { listAgentActivity } from "@/lib/learning/agent-activity";

async function setup() {
  const fake = createFakeLearningSupabase();
  const supabase = fake as never;
  const profile = await getOrCreateDefaultProfile({ supabase });
  return { supabase, fake, studentId: profile.id };
}

test("determinism: replanning against unchanged learner state produces an identical plan (aside from the log entry it writes)", async () => {
  const { supabase, studentId } = await setup();
  const { concept } = await createOrResolveConcept({ subject: "Determinism Subject", displayName: "Concept" }, { supabase });
  await recordScoredOutcomeWithRetention({ studentId, conceptId: concept.id, outcome: "incorrect", difficulty: "medium" }, { supabase });
  const now = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

  const first = await replanLearningPlan(studentId, "Determinism Subject", 45, {}, { supabase, now });
  const second = await replanLearningPlan(studentId, "Determinism Subject", 45, {}, { supabase, now });
  assert.deepEqual(first, second);
});

test("respects current priority ordering: a prerequisite blocker still schedules before the concept it blocks", async () => {
  const { supabase, studentId } = await setup();
  const { concept: prereq } = await createOrResolveConcept({ subject: "Replan Subject", displayName: "Arrays" }, { supabase });
  const { concept: target } = await createOrResolveConcept({ subject: "Replan Subject", displayName: "Binary Search" }, { supabase });
  const { addPrerequisite } = await import("@/lib/learning/concepts");
  await addPrerequisite(target.id, prereq.id, { supabase });
  for (let i = 0; i < 3; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId: target.id, outcome: "incorrect", difficulty: "medium" }, { supabase });

  const plan = await replanLearningPlan(studentId, "Replan Subject", 60, {}, { supabase });
  const prereqIndex = plan.items.findIndex((i) => i.conceptKey === prereq.conceptKey);
  const targetIndex = plan.items.findIndex((i) => i.conceptKey === target.conceptKey);
  assert.ok(prereqIndex !== -1 && targetIndex !== -1 && prereqIndex < targetIndex);
});

test("the time budget is still enforced on a replan exactly as on a fresh plan", async () => {
  const { supabase, studentId } = await setup();
  for (let i = 0; i < 5; i++) {
    const { concept } = await createOrResolveConcept({ subject: "Budget Replan Subject", displayName: `Concept ${i}` }, { supabase });
    await recordScoredOutcomeWithRetention({ studentId, conceptId: concept.id, outcome: "incorrect", difficulty: "medium" }, { supabase });
  }
  const plan = await replanLearningPlan(studentId, "Budget Replan Subject", 20, {}, { supabase });
  assert.ok(plan.estimatedMinutes <= 20);
});

test("skippedConceptIds excludes a concept from this replan only, without touching its stored evidence", async () => {
  const { supabase, studentId } = await setup();
  const { concept: a } = await createOrResolveConcept({ subject: "Skip Subject", displayName: "Alpha" }, { supabase });
  const { concept: b } = await createOrResolveConcept({ subject: "Skip Subject", displayName: "Beta" }, { supabase });
  await recordScoredOutcomeWithRetention({ studentId, conceptId: a.id, outcome: "incorrect", difficulty: "medium" }, { supabase });
  await recordScoredOutcomeWithRetention({ studentId, conceptId: b.id, outcome: "incorrect", difficulty: "medium" }, { supabase });

  const withoutSkip = await replanLearningPlan(studentId, "Skip Subject", 60, {}, { supabase });
  assert.ok(withoutSkip.items.some((i) => i.conceptKey === a.conceptKey));

  const withSkip = await replanLearningPlan(studentId, "Skip Subject", 60, { skippedConceptIds: [a.id] }, { supabase });
  assert.ok(!withSkip.items.some((i) => i.conceptKey === a.conceptKey));
  assert.ok(withSkip.items.some((i) => i.conceptKey === b.conceptKey));

  // The skip never touched stored evidence -- a fresh, unskipped replan brings the concept right back.
  const withoutSkipAgain = await replanLearningPlan(studentId, "Skip Subject", 60, {}, { supabase });
  assert.ok(withoutSkipAgain.items.some((i) => i.conceptKey === a.conceptKey));
});

test("next best action is refreshed on every replan call", async () => {
  const { supabase, studentId } = await setup();
  await createOrResolveConcept({ subject: "Next Action Subject", displayName: "Concept" }, { supabase });
  const plan = await replanLearningPlan(studentId, "Next Action Subject", 30, {}, { supabase });
  assert.ok(plan.nextBestAction.decision, "a next-best-action must always be present, freshly computed");
});

test("a successful replan logs a PLAN_REPLANNED activity row, distinct from PLAN_GENERATED", async () => {
  const { supabase, studentId } = await setup();
  await createOrResolveConcept({ subject: "Logged Replan Subject", displayName: "Concept" }, { supabase });
  await replanLearningPlan(studentId, "Logged Replan Subject", 30, { completedConceptId: "some-prior-concept-id" }, { supabase });

  const activity = await listAgentActivity(studentId, { subject: "logged-replan-subject" }, { supabase });
  assert.equal(activity.length, 1);
  assert.equal(activity[0].kind, "PLAN_REPLANNED");
  assert.equal(activity[0].metadata.completedConceptId, "some-prior-concept-id");
});
