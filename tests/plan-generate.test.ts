import assert from "node:assert/strict";
import test from "node:test";
import { generateLearningPlan } from "@/lib/plan/generate";
import { PlanValidationError } from "@/lib/plan/budget";
import { createFakeLearningSupabase } from "./support/fake-learning-db";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { createOrResolveConcept, addPrerequisite } from "@/lib/learning/concepts";
import { recordScoredOutcomeWithRetention } from "@/lib/learning/reviews";

async function setup() {
  const fake = createFakeLearningSupabase();
  const supabase = fake as never;
  const profile = await getOrCreateDefaultProfile({ supabase });
  return { supabase, fake, studentId: profile.id };
}

test("generates an ordered, time-budgeted plan from existing weak-concept evidence, never inventing a new score", async () => {
  const { supabase, studentId } = await setup();
  const { concept: weak } = await createOrResolveConcept({ subject: "Machine Learning", displayName: "Linear Regression" }, { supabase });
  for (let i = 0; i < 3; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId: weak.id, outcome: "incorrect", difficulty: "medium" }, { supabase });

  const plan = await generateLearningPlan(studentId, "Machine Learning", 60, { supabase });

  assert.equal(plan.subject, "machine-learning");
  assert.equal(plan.availableMinutes, 60);
  assert.ok(plan.estimatedMinutes <= 60);
  assert.ok(plan.items.length >= 1);
  assert.equal(plan.items[0].conceptKey, weak.conceptKey);
  assert.ok(plan.items[0].reasonCodes.includes("MASTERY_DEVELOPING"));
  assert.ok(plan.nextBestAction, "next best action must be present, reused from selectNextActivity()");
  assert.ok(new Date(plan.generatedAt).getTime() <= Date.now());
});

test("respects prerequisite ordering: a zero-evidence blocker is scheduled before the concept it blocks", async () => {
  const { supabase, studentId } = await setup();
  const { concept: prereq } = await createOrResolveConcept({ subject: "Data Structures", displayName: "Arrays" }, { supabase });
  const { concept: target } = await createOrResolveConcept({ subject: "Data Structures", displayName: "Binary Search" }, { supabase });
  await addPrerequisite(target.id, prereq.id, { supabase });
  for (let i = 0; i < 3; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId: target.id, outcome: "incorrect", difficulty: "medium" }, { supabase });

  const plan = await generateLearningPlan(studentId, "Data Structures", 60, { supabase });
  const prereqIndex = plan.items.findIndex((i) => i.conceptKey === prereq.conceptKey);
  const targetIndex = plan.items.findIndex((i) => i.conceptKey === target.conceptKey);
  assert.ok(prereqIndex !== -1, "the prerequisite must appear in the plan");
  assert.ok(targetIndex !== -1, "the target must appear in the plan");
  assert.ok(prereqIndex < targetIndex, "the prerequisite must be scheduled before the concept it blocks");
  assert.equal(plan.items[prereqIndex].activityType, "learn");
});

test("never exceeds the requested time budget, and shrinks the plan for a smaller budget", async () => {
  const { supabase, studentId } = await setup();
  for (let i = 0; i < 5; i++) {
    const { concept } = await createOrResolveConcept({ subject: "Budget Subject", displayName: `Concept ${i}` }, { supabase });
    await recordScoredOutcomeWithRetention({ studentId, conceptId: concept.id, outcome: "incorrect", difficulty: "medium" }, { supabase });
  }

  const bigPlan = await generateLearningPlan(studentId, "Budget Subject", 60, { supabase });
  const smallPlan = await generateLearningPlan(studentId, "Budget Subject", 15, { supabase });

  assert.ok(bigPlan.estimatedMinutes <= 60);
  assert.ok(smallPlan.estimatedMinutes <= 15);
  assert.ok(bigPlan.items.length >= smallPlan.items.length, "a larger budget must never produce fewer scheduled items");
});

test("returns an empty (never throwing) item list for a subject with no assessed concepts, while still surfacing next-best-action", async () => {
  const { supabase, studentId } = await setup();
  await createOrResolveConcept({ subject: "Untouched Subject", displayName: "Fresh Concept" }, { supabase });

  const plan = await generateLearningPlan(studentId, "Untouched Subject", 30, { supabase });
  assert.deepEqual(plan.items, []);
  assert.equal(plan.estimatedMinutes, 0);
  assert.ok(plan.nextBestAction.decision, "a fresh, zero-evidence subject still gets a next-best-action from the existing DIAGNOSTIC-phase selection");
});

test("zero-state (no learner history at all in this subject) yields an honest INSUFFICIENT_EVIDENCE next-best-action, never a fabricated weakness", async () => {
  const { supabase, studentId } = await setup();
  await createOrResolveConcept({ subject: "Brand New Subject", displayName: "First Concept" }, { supabase });
  await createOrResolveConcept({ subject: "Brand New Subject", displayName: "Second Concept" }, { supabase });

  const plan = await generateLearningPlan(studentId, "Brand New Subject", 30, { supabase });
  assert.deepEqual(plan.items, []);
  assert.ok(plan.nextBestAction.decision, "a completely new learner still gets a deterministic first next-best-action");
  assert.ok(plan.nextBestAction.decision!.reasonCodes.includes("INSUFFICIENT_EVIDENCE"), "cold start must be labeled honestly, never as a mastery gap or weakness");
});

test("propagates the budget packer's validation error for an out-of-range budget, never silently clamping it", async () => {
  const { supabase, studentId } = await setup();
  await createOrResolveConcept({ subject: "Invalid Budget Subject", displayName: "Concept" }, { supabase });
  await assert.rejects(() => generateLearningPlan(studentId, "Invalid Budget Subject", 0, { supabase }), PlanValidationError);
  await assert.rejects(() => generateLearningPlan(studentId, "Invalid Budget Subject", 1000, { supabase }), PlanValidationError);
});

test("determinism: same DB state + same injected now produces an identical plan across repeated calls", async () => {
  const { supabase, studentId } = await setup();
  const { concept } = await createOrResolveConcept({ subject: "Determinism Subject", displayName: "Concept" }, { supabase });
  await recordScoredOutcomeWithRetention({ studentId, conceptId: concept.id, outcome: "incorrect", difficulty: "medium" }, { supabase });
  const now = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

  const first = await generateLearningPlan(studentId, "Determinism Subject", 45, { supabase, now });
  const second = await generateLearningPlan(studentId, "Determinism Subject", 45, { supabase, now });
  assert.deepEqual(first, second);
});
