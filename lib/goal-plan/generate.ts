// Multi-day adaptive exam roadmap (standout feature, Phase 3). A deterministic orchestration layer
// composing ONLY existing systems -- lib/learning/recommendations.ts for priority + prerequisite
// order, lib/pedagogy/select.ts for today's next-best-action, lib/learning/analytics.ts +
// lib/goal-plan/readiness.ts for the one restrained readiness percentage, and lib/plan/budget.ts's
// existing packPlan() for every single day's time-budgeting. No second priority formula, no second
// prerequisite engine, no new mastery/retention model, and no LLM in this file at all.
//
// THE CORE GUARANTEE ("no fake future progress"): every candidate this module schedules comes from
// ONE snapshot of CURRENT learner state, read once at the top of generateGoalPlan(). Distributing
// that same fixed, already-ranked, already-prerequisite-ordered list across days by REMOVING an item
// once it has been scheduled (never by assuming it gets "learned" and re-ranking as if mastery had
// improved) is what keeps every future day an honest projection of "if you worked through today's
// item, here is what's still outstanding" -- never a simulated mastery gain. Nothing in this file
// calls applyLearningOutcome/applyRetentionOutcome or writes any learner-state table; regenerating
// (lib/goal-plan's own "Adapt Roadmap") only ever re-reads the CURRENT (possibly since-changed, via
// the real quiz/practice flows) state and starts this same process over.

import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getRevisionRecommendations, type RevisionRecommendation } from "@/lib/learning/recommendations";
import { getSubjectAnalytics } from "@/lib/learning/analytics";
import { selectNextActivity } from "@/lib/pedagogy/select";
import { normalizeSubjectKey } from "@/lib/learning/concepts";
import { packPlan, deriveActivityType, type PlanCandidate } from "@/lib/plan/budget";
import { recordAgentActivity, type AgentActivityKind } from "@/lib/learning/agent-activity";
import { computeExamReadiness } from "@/lib/goal-plan/readiness";
import { GOAL_PLAN_MAX_HORIZON_DAYS } from "@/lib/goal-plan/constants";
import type { GoalPlan, GoalPlanDay } from "@/types/goal-plan";
import type { RevisionReasonCode } from "@/types/progress";

export class GoalPlanValidationError extends Error {}

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toMidnightUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function toCandidate(recommendation: RevisionRecommendation): PlanCandidate {
  return {
    conceptId: recommendation.conceptId,
    conceptKey: recommendation.conceptKey,
    displayName: recommendation.displayName,
    subject: recommendation.subject,
    reasonCodes: recommendation.reasonCodes as RevisionReasonCode[],
  };
}

export interface GenerateGoalPlanDependencies {
  supabase?: SupabaseClient;
  now?: Date;
  // Defaults to "PLAN_GENERATED" -- the UI's "Adapt Roadmap" action passes "PLAN_REPLANNED" instead,
  // exactly mirroring lib/plan/generate.ts's own activityKind convention. Both are logged with
  // metadata.mode = "goal" so Recent Decisions can tell a goal-roadmap entry apart from an ordinary
  // TODAY-plan entry without a schema change (see this module's own header note on activity kinds).
  activityKind?: Extract<AgentActivityKind, "PLAN_GENERATED" | "PLAN_REPLANNED">;
}

/**
 * Composes existing recommendation ranking + readiness + next-activity intelligence into a
 * day-by-day roadmap from today through `examDate` (inclusive). `minutesPerDay` is validated by
 * lib/plan/budget.ts's packPlan() on the first day it's applied to -- mirrors
 * lib/plan/generate.ts's own "the API route validates the same bounds up front too" convention.
 */
export async function generateGoalPlan(studentId: string, subject: string, examDate: string, minutesPerDay: number, dependencies: GenerateGoalPlanDependencies = {}): Promise<GoalPlan> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const now = dependencies.now ?? new Date();
  const normalizedSubject = normalizeSubjectKey(subject);

  const parsedExamDate = new Date(examDate);
  if (Number.isNaN(parsedExamDate.getTime())) throw new GoalPlanValidationError("examDate must be a valid date.");

  const today = toMidnightUtc(now);
  const examDay = toMidnightUtc(parsedExamDate);
  const daysUntilExam = Math.round((examDay.getTime() - today.getTime()) / MS_PER_DAY);
  if (daysUntilExam <= 0) throw new GoalPlanValidationError("examDate must be in the future.");
  if (daysUntilExam > GOAL_PLAN_MAX_HORIZON_DAYS) throw new GoalPlanValidationError(`examDate must be within ${GOAL_PLAN_MAX_HORIZON_DAYS} days from today.`);

  const [{ recommendations, transferPractice }, analytics, nextBestAction] = await Promise.all([
    getRevisionRecommendations(studentId, { subject: normalizedSubject }, { supabase, now }),
    getSubjectAnalytics(studentId, normalizedSubject, { supabase, now }),
    selectNextActivity(studentId, normalizedSubject, { supabase, now }),
  ]);

  const readiness = computeExamReadiness(analytics);

  // ONE fixed, deduplicated, already-prerequisite-ordered pool -- the single snapshot of current
  // state every day below draws from. Deduplicating here (not just inside each packPlan() call) is
  // what makes cross-day scheduling honest: once a concept is scheduled on an earlier day, it is
  // removed from the pool entirely rather than being eligible to reappear "for free" on a later day.
  const seen = new Set<string>();
  let pool: PlanCandidate[] = [...recommendations, ...transferPractice].map(toCandidate).filter((c) => (seen.has(c.conceptId) ? false : (seen.add(c.conceptId), true)));

  const totalDays = daysUntilExam + 1; // today (index 0) through the exam day (index totalDays - 1), inclusive
  const days: GoalPlanDay[] = [];
  for (let i = 0; i < totalDays; i++) {
    const isExamDay = i === totalDays - 1;
    // Exam-day safety: never start a brand-new PREREQUISITE_REMEDIATION ("learn") item the day of
    // the exam itself -- only review/practice-type items already in the pool are eligible. This
    // filters the pool, it never reorders it, so the prerequisite-order invariant packPlan() relies
    // on is untouched for whichever items remain.
    const dayPool = isExamDay ? pool.filter((c) => deriveActivityType(c.reasonCodes) !== "learn") : pool;
    const { items, estimatedMinutes } = packPlan(dayPool, minutesPerDay);

    const scheduled = new Set(items.map((item) => item.conceptId));
    pool = pool.filter((c) => !scheduled.has(c.conceptId)); // never repeat an already-scheduled concept on a later day

    days.push({ date: toIsoDate(addUtcDays(today, i)), isExamDay, availableMinutes: minutesPerDay, estimatedMinutes, items });
  }

  const firstItem = days[0]?.items[0];
  const conceptId = firstItem?.conceptId ?? nextBestAction.decision?.targetConceptId ?? null;
  const conceptKey = firstItem?.conceptKey ?? nextBestAction.decision?.targetConceptKey ?? null;
  const reasonCodes = firstItem?.reasonCodes ?? nextBestAction.decision?.reasonCodes ?? [];

  await recordAgentActivity(
    {
      studentId,
      subject: normalizedSubject,
      kind: dependencies.activityKind ?? "PLAN_GENERATED",
      conceptId,
      conceptKey,
      reasonCodes,
      metadata: { mode: "goal", examDate: toIsoDate(examDay), minutesPerDay, daysRemaining: daysUntilExam, readinessPercent: readiness.readyPercent },
    },
    { supabase },
  );

  return {
    subject: normalizedSubject,
    examDate: toIsoDate(examDay),
    generatedAt: now.toISOString(),
    daysRemaining: daysUntilExam,
    minutesPerDay,
    readiness,
    days,
    nextBestAction,
  };
}
