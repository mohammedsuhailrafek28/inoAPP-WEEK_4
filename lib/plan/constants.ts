// Week 4 planning-layer constants. Deliberately kept separate from lib/learning/constants.ts's
// versioned LEARNING_CONFIG registry (ARCHITECTURE.md §6A) -- that registry is locked to the
// frozen Week 3 learner-intelligence algorithms (BKT/IRT/FSRS/PFA/etc.), never touched here. These
// are plain Week 4 product-policy numbers for the new planning layer, not a Week 3 model parameter.

import type { PlanActivityType } from "@/types/plan";

// Deterministic per-activity-type duration budget (minutes). Fixed and auditable -- never assigned
// by Gemini and never derived from a candidate's priority score (see lib/plan/budget.ts's header
// comment on why duration is a lookup, not a generated or computed value).
export const PLAN_ACTIVITY_DURATION_MINUTES: Record<PlanActivityType, number> = {
  review: 15,
  practice: 15,
  learn: 20,
};

// Sane bounds on a client-requested time budget -- rejects nonsense (0, negative, an unbounded
// "study for 100 hours" request) at the API boundary rather than silently accepting it.
export const PLAN_MIN_AVAILABLE_MINUTES = 5;
export const PLAN_MAX_AVAILABLE_MINUTES = 240;
