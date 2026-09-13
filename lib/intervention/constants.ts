// Intervention Coach constants. Duration policy itself is NOT duplicated here -- every recovery
// item's estimatedMinutes comes from lib/plan/constants.ts::PLAN_ACTIVITY_DURATION_MINUTES verbatim
// (via lib/plan/budget.ts::deriveActivityType()). This file holds only the one number genuinely new
// to this feature: the recovery sequence's own time ceiling.

// A fixed ceiling for the recovery sequence's total estimated minutes. The hand-authored sequences
// this feature ever produces top out at 50 minutes (learn 20 + practice 15 + practice 15, the
// richest case), so 60 is a generous, documented safety margin -- verified by a dedicated test, not
// merely assumed. Never enforced by re-running lib/plan/budget.ts::packPlan() (see
// lib/intervention/generate.ts's header comment on why that function's per-concept dedup doesn't fit
// a sequence that deliberately revisits the same blocker concept twice).
export const INTERVENTION_RECOVERY_BUDGET_MINUTES = 60;
