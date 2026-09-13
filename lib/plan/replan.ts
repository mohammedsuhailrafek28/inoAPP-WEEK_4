// Plan replanning (Week 4, Phase D). A thin wrapper, not a second plan implementation: replanning
// IS generateLearningPlan() called again against whatever the CURRENT authoritative learner state
// is right now (recommendations/readiness/next-best-action are already recomputed fresh on every
// call -- there is no cache to invalidate). The only differences from a plain plan fetch are the
// logged activity kind and the optional "skip this concept for this replan" filter.
//
// This module never mutates mastery, retention, or any other learner-state table -- real progress
// still only ever comes from the existing trusted lib/quiz/service.ts / lib/learning/reviews.ts
// write paths. Clicking "replan" (or completing/skipping an item) cannot fabricate evidence.

import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { generateLearningPlan, type GenerateLearningPlanDependencies } from "@/lib/plan/generate";
import type { LearningPlan } from "@/types/plan";

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

export interface ReplanLearningPlanOptions {
  skippedConceptIds?: string[];
  completedConceptId?: string | null;
}

export interface ReplanLearningPlanDependencies {
  supabase?: SupabaseClient;
  now?: Date;
}

export async function replanLearningPlan(studentId: string, subject: string, availableMinutes: number, options: ReplanLearningPlanOptions = {}, dependencies: ReplanLearningPlanDependencies = {}): Promise<LearningPlan> {
  const planDependencies: GenerateLearningPlanDependencies = {
    supabase: dependencies.supabase,
    now: dependencies.now,
    activityKind: "PLAN_REPLANNED",
    excludeConceptIds: options.skippedConceptIds,
    completedConceptId: options.completedConceptId,
  };
  return generateLearningPlan(studentId, subject, availableMinutes, planDependencies);
}
