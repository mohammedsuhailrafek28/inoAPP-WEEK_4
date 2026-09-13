// Week 4 planning-layer types (autonomous learning plan generator). Client-safe -- no server-only
// import -- mirroring the exact "server decides, frontend displays" split types/progress.ts already
// established for Week 3 (Phase 12): the frontend never computes a duration, priority, or activity
// type itself; it only renders what the server already decided.

import type { NextActivityResult, RevisionReasonCode } from "@/types/progress";

// A restrained, closed vocabulary derived from existing RevisionReasonCode/pedagogical signals
// (lib/plan/budget.ts::deriveActivityType()) -- never a second scoring system. "review" mirrors the
// existing SPACED_REVIEW pedagogical action; "learn" mirrors PREREQUISITE_REMEDIATION; "practice"
// mirrors QUIZ/TRANSFER_CHALLENGE/ordinary applied practice. Deliberately NOT reusing
// PedagogicalAction's full enum directly -- a study plan item is coarser ("what kind of block is
// this") than a single pedagogical decision, and collapsing to 3 buckets keeps the duration policy
// small and auditable.
export const PLAN_ACTIVITY_TYPES = ["review", "practice", "learn"] as const;
export type PlanActivityType = (typeof PLAN_ACTIVITY_TYPES)[number];

export interface PlanItem {
  order: number; // 1-based position in the packed plan
  conceptId: string;
  conceptKey: string;
  displayName: string;
  subject: string;
  activityType: PlanActivityType;
  estimatedMinutes: number;
  reasonCodes: RevisionReasonCode[]; // verbatim from lib/learning/recommendations.ts -- never re-derived client-side
}

export interface LearningPlan {
  subject: string;
  availableMinutes: number;
  estimatedMinutes: number; // sum of items[].estimatedMinutes -- never exceeds availableMinutes
  generatedAt: string;
  items: PlanItem[];
  // lib/pedagogy/select.ts::selectNextActivity(), reused verbatim -- never recomputed in the plan
  // layer or on the client. The server's actual payload here is the fuller
  // types/learning.ts::NextActivityResult shape; this client-safe mirror only declares the fields
  // the UI is allowed to depend on, the same convention GET /api/learning/next-activity already uses.
  nextBestAction: NextActivityResult;
}
