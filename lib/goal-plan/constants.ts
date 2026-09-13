// Exam Goal Mode constants. minutesPerDay reuses lib/plan/constants.ts's existing
// PLAN_MIN/MAX_AVAILABLE_MINUTES verbatim (a legitimate reuse -- "minutes available per study day"
// is the same kind of bound as "minutes available for a single session"), so only the
// roadmap-horizon cap is new here.

// A hard ceiling on how many calendar days a roadmap may span, so a client can never request
// "generate several years of daily items" (an unbounded response, and a meaningless one -- current
// learner state many months out predicts nothing). Two weeks comfortably covers a real exam-prep
// window without inviting an absurd request.
export const GOAL_PLAN_MAX_HORIZON_DAYS = 14;
