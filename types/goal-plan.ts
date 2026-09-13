// Exam Goal Mode / multi-day adaptive roadmap (standout feature, beyond the Week 4 baseline).
// Client-safe: no server-only import, mirroring the exact split types/plan.ts already established.
// Deliberately reuses PlanItem verbatim (types/plan.ts) for every scheduled day -- a roadmap day is
// structurally just another time-budgeted plan, produced by the SAME lib/plan/budget.ts packer; no
// second item shape is invented here.

import type { PlanItem } from "@/types/plan";
import type { NextActivityResult } from "@/types/progress";

export interface ExamGoal {
  subject: string;
  examDate: string; // ISO calendar date, "YYYY-MM-DD"
  minutesPerDay: number;
}

export interface GoalPlanDay {
  date: string; // ISO calendar date, "YYYY-MM-DD"
  isExamDay: boolean;
  availableMinutes: number;
  estimatedMinutes: number; // never exceeds availableMinutes -- lib/plan/budget.ts::packPlan()'s own guarantee, reused per day
  items: PlanItem[]; // empty when the ranked candidate pool has already been exhausted by earlier days -- an honest empty day, never filler
}

// The one deliberately restrained, explainable readiness metric (lib/goal-plan/readiness.ts) -- a
// ratio over an already-computed, already-displayed categorical field (MasteryStage), never a
// blended/weighted "score soup" of unrelated signals. reviewDueCount/activeMisconceptionCount are
// surfaced separately, alongside the ratio, never folded into it.
export interface ExamReadiness {
  readyConceptCount: number; // concepts at MASTERED or PROFICIENT stage
  totalConceptCount: number; // every concept registered in the subject, assessed or not
  readyPercent: number; // round(readyConceptCount / totalConceptCount * 100); 0 when totalConceptCount is 0
  reviewDueCount: number; // stageCounts.REVIEW_DUE, surfaced as-is -- never blended into readyPercent
  activeMisconceptionCount: number; // surfaced as-is -- never blended into readyPercent
  category: "LOW" | "DEVELOPING" | "READY"; // a restrained headline banding of readyPercent, presentation-only
}

export interface GoalPlan {
  subject: string;
  examDate: string; // ISO calendar date, normalized
  generatedAt: string;
  daysRemaining: number; // whole calendar days between today and examDate (today excluded from the count, included in `days`)
  minutesPerDay: number;
  readiness: ExamReadiness;
  days: GoalPlanDay[]; // days[0] is today, days[days.length - 1] is the exam day itself
  // lib/pedagogy/select.ts::selectNextActivity(), reused verbatim for TODAY only -- never recomputed
  // for a future day, since a future day's "next action" would require assuming state that hasn't
  // actually changed yet (see lib/goal-plan/generate.ts's header comment on this exact boundary).
  nextBestAction: NextActivityResult;
}
