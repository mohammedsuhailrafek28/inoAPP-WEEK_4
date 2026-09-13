import assert from "node:assert/strict";
import test from "node:test";
import { generateGoalPlan, GoalPlanValidationError } from "@/lib/goal-plan/generate";
import { createFakeLearningSupabase } from "./support/fake-learning-db";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { createOrResolveConcept, addPrerequisite } from "@/lib/learning/concepts";
import { recordScoredOutcomeWithRetention } from "@/lib/learning/reviews";
import { listAgentActivity } from "@/lib/learning/agent-activity";

async function setup() {
  const fake = createFakeLearningSupabase();
  const supabase = fake as never;
  const profile = await getOrCreateDefaultProfile({ supabase });
  return { supabase, fake, studentId: profile.id };
}

// A fixed "today," safely far in the future relative to the real wall clock -- every
// recordScoredOutcomeWithRetention() call below stamps its evidence with the REAL current time
// (that write path has no injectable `now`), so `now` here must be later than that real timestamp
// or the retention math correctly refuses a negative elapsed time (mirrors tests/plan-generate.test.ts's
// own "safely after any real timestamp the fake DB just wrote" convention).
const NOW = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);

function isoDateAt(offsetDays: number): string {
  const d = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

test("rejects a past or same-day exam date", async () => {
  const { supabase, studentId } = await setup();
  await createOrResolveConcept({ subject: "Past Date Subject", displayName: "Concept" }, { supabase });
  await assert.rejects(() => generateGoalPlan(studentId, "Past Date Subject", isoDateAt(-1), 30, { supabase, now: NOW }), GoalPlanValidationError);
  await assert.rejects(() => generateGoalPlan(studentId, "Past Date Subject", isoDateAt(0), 30, { supabase, now: NOW }), GoalPlanValidationError); // exam date == today is not "future"
});

test("rejects a malformed exam date", async () => {
  const { supabase, studentId } = await setup();
  await createOrResolveConcept({ subject: "Malformed Date Subject", displayName: "Concept" }, { supabase });
  await assert.rejects(() => generateGoalPlan(studentId, "Malformed Date Subject", "not-a-date", 30, { supabase, now: NOW }), GoalPlanValidationError);
});

test("rejects an exam date beyond the roadmap horizon cap", async () => {
  const { supabase, studentId } = await setup();
  await createOrResolveConcept({ subject: "Horizon Subject", displayName: "Concept" }, { supabase });
  await assert.rejects(() => generateGoalPlan(studentId, "Horizon Subject", isoDateAt(30), 30, { supabase, now: NOW }), GoalPlanValidationError);
});

test("zero-state (brand-new learner, no evidence at all): honest 0% readiness, empty day items, never throws", async () => {
  const { supabase, studentId } = await setup();
  await createOrResolveConcept({ subject: "Cold Start Exam Subject", displayName: "First Concept" }, { supabase });
  await createOrResolveConcept({ subject: "Cold Start Exam Subject", displayName: "Second Concept" }, { supabase });

  const roadmap = await generateGoalPlan(studentId, "Cold Start Exam Subject", isoDateAt(7), 30, { supabase, now: NOW });
  assert.equal(roadmap.readiness.readyPercent, 0);
  assert.equal(roadmap.readiness.readyConceptCount, 0);
  assert.equal(roadmap.readiness.totalConceptCount, 2);
  assert.equal(roadmap.readiness.category, "LOW");
  for (const day of roadmap.days) assert.deepEqual(day.items, []);
  assert.ok(roadmap.nextBestAction.decision, "still surfaces a deterministic first next-best-action from existing DIAGNOSTIC-phase selection");
});

test("a valid future exam date produces a roadmap with one entry per day, today through the exam day inclusive", async () => {
  const { supabase, studentId } = await setup();
  const { concept } = await createOrResolveConcept({ subject: "Valid Roadmap Subject", displayName: "Concept" }, { supabase });
  await recordScoredOutcomeWithRetention({ studentId, conceptId: concept.id, outcome: "incorrect", difficulty: "medium" }, { supabase });

  const plan = await generateGoalPlan(studentId, "Valid Roadmap Subject", isoDateAt(6), 30, { supabase, now: NOW });
  assert.equal(plan.daysRemaining, 6);
  assert.equal(plan.days.length, 7); // today through 6 days out, inclusive
  assert.equal(plan.days[0].date, isoDateAt(0));
  assert.equal(plan.days[plan.days.length - 1].date, isoDateAt(6));
  assert.equal(plan.days[plan.days.length - 1].isExamDay, true);
  assert.ok(plan.days.slice(0, -1).every((d) => !d.isExamDay));
  assert.ok(plan.nextBestAction, "next best action must be present");
});

test("determinism: identical inputs (including injected now) produce an identical roadmap", async () => {
  const { supabase, studentId } = await setup();
  const { concept } = await createOrResolveConcept({ subject: "Determinism Subject", displayName: "Concept" }, { supabase });
  await recordScoredOutcomeWithRetention({ studentId, conceptId: concept.id, outcome: "incorrect", difficulty: "medium" }, { supabase });

  const first = await generateGoalPlan(studentId, "Determinism Subject", isoDateAt(3), 30, { supabase, now: NOW });
  const second = await generateGoalPlan(studentId, "Determinism Subject", isoDateAt(3), 30, { supabase, now: NOW });
  assert.deepEqual(first, second);
});

test("no day's estimated minutes ever exceed minutesPerDay", async () => {
  const { supabase, studentId } = await setup();
  for (let i = 0; i < 6; i++) {
    const { concept } = await createOrResolveConcept({ subject: "Budget Subject", displayName: `Concept ${i}` }, { supabase });
    await recordScoredOutcomeWithRetention({ studentId, conceptId: concept.id, outcome: "incorrect", difficulty: "medium" }, { supabase });
  }
  const plan = await generateGoalPlan(studentId, "Budget Subject", isoDateAt(4), 20, { supabase, now: NOW });
  for (const day of plan.days) {
    assert.ok(day.estimatedMinutes <= 20, `day ${day.date} scheduled ${day.estimatedMinutes} > 20`);
  }
});

test("a concept is never scheduled on two different days -- cross-day dedup, not blind repetition", async () => {
  const { supabase, studentId } = await setup();
  for (let i = 0; i < 5; i++) {
    const { concept } = await createOrResolveConcept({ subject: "No Repeat Subject", displayName: `Concept ${i}` }, { supabase });
    await recordScoredOutcomeWithRetention({ studentId, conceptId: concept.id, outcome: "incorrect", difficulty: "medium" }, { supabase });
  }
  const plan = await generateGoalPlan(studentId, "No Repeat Subject", isoDateAt(7), 15, { supabase, now: NOW });
  const allConceptIds = plan.days.flatMap((d) => d.items.map((i) => i.conceptId));
  assert.equal(allConceptIds.length, new Set(allConceptIds).size, "the same concept appeared on more than one day");
});

test("prerequisite ordering is preserved across the roadmap: a blocker is scheduled on an earlier or the same day as the concept it blocks, never later", async () => {
  const { supabase, studentId } = await setup();
  const { concept: prereq } = await createOrResolveConcept({ subject: "Roadmap Prereq Subject", displayName: "Arrays" }, { supabase });
  const { concept: target } = await createOrResolveConcept({ subject: "Roadmap Prereq Subject", displayName: "Binary Search" }, { supabase });
  await addPrerequisite(target.id, prereq.id, { supabase });
  for (let i = 0; i < 3; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId: target.id, outcome: "incorrect", difficulty: "medium" }, { supabase });

  const plan = await generateGoalPlan(studentId, "Roadmap Prereq Subject", isoDateAt(8), 60, { supabase, now: NOW });
  const dayIndexOf = (conceptKey: string) => plan.days.findIndex((d) => d.items.some((i) => i.conceptKey === conceptKey));
  const prereqDay = dayIndexOf(prereq.conceptKey);
  const targetDay = dayIndexOf(target.conceptKey);
  assert.ok(prereqDay !== -1 && targetDay !== -1, "both the blocker and the blocked concept must appear somewhere in the roadmap");
  assert.ok(prereqDay <= targetDay, "the prerequisite must never be scheduled after the concept it blocks");
});

test("exam day never schedules a new prerequisite-remediation ('learn') item", async () => {
  const { supabase, studentId } = await setup();
  const { concept: prereq } = await createOrResolveConcept({ subject: "Exam Day Safety Subject", displayName: "Prereq" }, { supabase });
  const { concept: target } = await createOrResolveConcept({ subject: "Exam Day Safety Subject", displayName: "Target" }, { supabase });
  await addPrerequisite(target.id, prereq.id, { supabase });
  for (let i = 0; i < 3; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId: target.id, outcome: "incorrect", difficulty: "medium" }, { supabase });

  // A tight per-day budget and a short horizon forces the "learn" blocker item to still be
  // unscheduled by the final (exam) day if it were eligible there.
  const plan = await generateGoalPlan(studentId, "Exam Day Safety Subject", isoDateAt(1), 5, { supabase, now: NOW });
  const examDay = plan.days[plan.days.length - 1];
  assert.ok(examDay.items.every((i) => i.activityType !== "learn"), "the exam day must never contain a 'learn' item");
});

test("one-day-remaining roadmap (exam is tomorrow) produces exactly 2 entries: today and the exam day", async () => {
  const { supabase, studentId } = await setup();
  await createOrResolveConcept({ subject: "One Day Subject", displayName: "Concept" }, { supabase });
  const plan = await generateGoalPlan(studentId, "One Day Subject", isoDateAt(1), 30, { supabase, now: NOW });
  assert.equal(plan.daysRemaining, 1);
  assert.equal(plan.days.length, 2);
  assert.equal(plan.days[1].isExamDay, true);
});

test("readiness is included and matches the existing analytics-derived stage distribution", async () => {
  const { supabase, studentId } = await setup();
  const { concept } = await createOrResolveConcept({ subject: "Readiness Roadmap Subject", displayName: "Concept" }, { supabase });
  for (let i = 0; i < 6; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId: concept.id, outcome: "correct", difficulty: "medium" }, { supabase });

  // A `now` shortly after the real writes above (not the far-future NOW used elsewhere in this
  // file) -- retrievability decays with elapsed time, so evaluating "mastered" 400 days out would
  // correctly flip this concept to REVIEW_DUE instead. This test is about the mastery ratio itself,
  // not retention decay, so it uses a near-term now/examDate pair.
  const soon = new Date(Date.now() + 5_000);
  const examDate = new Date(Date.UTC(soon.getUTCFullYear(), soon.getUTCMonth(), soon.getUTCDate() + 2)).toISOString().slice(0, 10);
  const plan = await generateGoalPlan(studentId, "Readiness Roadmap Subject", examDate, 30, { supabase, now: soon });
  assert.equal(plan.readiness.totalConceptCount, 1);
  assert.equal(plan.readiness.readyConceptCount, 1); // mastered after 6 correct answers
  assert.equal(plan.readiness.readyPercent, 100);
  assert.equal(plan.readiness.category, "READY");
});

test("a successful generation logs exactly one activity row, tagged with mode='goal'", async () => {
  const { supabase, studentId } = await setup();
  await createOrResolveConcept({ subject: "Activity Roadmap Subject", displayName: "Concept" }, { supabase });
  await generateGoalPlan(studentId, "Activity Roadmap Subject", isoDateAt(3), 30, { supabase, now: NOW });

  const activity = await listAgentActivity(studentId, { subject: "activity-roadmap-subject" }, { supabase });
  assert.equal(activity.length, 1);
  assert.equal(activity[0].kind, "PLAN_GENERATED");
  assert.equal(activity[0].metadata.mode, "goal");
  assert.equal(activity[0].metadata.daysRemaining, 3);
});

test("regeneration ('Adapt Roadmap') logs PLAN_REPLANNED instead of PLAN_GENERATED, still tagged mode='goal'", async () => {
  const { supabase, studentId } = await setup();
  await createOrResolveConcept({ subject: "Regen Roadmap Subject", displayName: "Concept" }, { supabase });
  await generateGoalPlan(studentId, "Regen Roadmap Subject", isoDateAt(3), 30, { supabase, now: NOW });
  await generateGoalPlan(studentId, "Regen Roadmap Subject", isoDateAt(3), 30, { supabase, now: NOW, activityKind: "PLAN_REPLANNED" });

  const activity = await listAgentActivity(studentId, { subject: "regen-roadmap-subject" }, { supabase });
  assert.equal(activity.length, 2);
  assert.equal(activity[0].kind, "PLAN_REPLANNED"); // most recent first
  assert.equal(activity[0].metadata.mode, "goal");
  assert.equal(activity[1].kind, "PLAN_GENERATED");
});
