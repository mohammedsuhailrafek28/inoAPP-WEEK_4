// Presentation-only label lookups (ARCHITECTURE.md §30.4-30.5, Phase 12). Every value here is
// a 1:1 mapping from an enum the SERVER already returned to a learner-friendly string -- this file
// never derives, computes, or re-interprets a stage/action/reason from raw evidence (Step 9: "the
// frontend does NOT generate its own reason... no client-side interpretation like
// if stage === DEVELOPING"). It only answers "what word do we print for this enum value the server
// gave us," the same category of work as MessageBubble.tsx's existing MODE_META lookup.
//
// Client-safe: imports only types (types/progress.ts), never lib/learning/* or lib/pedagogy/*
// (which are `server-only` and would break client bundling).

import type { CalibrationState, DifficultyBand, MasteryStage, PedagogicalAction, PedagogicalReasonCode, RevisionReasonCode, ScaffoldingLevel, TransferReadiness } from "@/types/progress";
import type { PlanActivityType } from "@/types/plan";
import type { AgentActivityKind } from "@/types/agent-activity";
import type { TeachBackUnderstanding } from "@/types/teach-back";

export const STAGE_LABEL: Record<MasteryStage, string> = {
  NEW: "New",
  LEARNING: "Learning",
  DEVELOPING: "Developing",
  PROFICIENT: "Proficient",
  MASTERED: "Mastered",
  REVIEW_DUE: "Review due",
};

// A restrained, non-color-only indicator per stage (Step 8: "do not encode status by color alone")
// -- a small glyph + the label together, never color alone.
export const STAGE_GLYPH: Record<MasteryStage, string> = {
  NEW: "○",
  LEARNING: "◔",
  DEVELOPING: "◑",
  PROFICIENT: "◕",
  MASTERED: "●",
  REVIEW_DUE: "↻",
};

export const ACTION_LABEL: Record<PedagogicalAction, string> = {
  EXPLAIN: "Explain",
  SIMPLIFY: "Simplify",
  DEEPEN: "Go deeper",
  QUIZ: "Practice",
  HINT: "Hint",
  CONTINUE: "Continue",
  SPACED_REVIEW: "Review",
  PREREQUISITE_REMEDIATION: "Prerequisite first",
  TRANSFER_CHALLENGE: "Apply it",
};

export const SCAFFOLDING_LABEL: Record<ScaffoldingLevel, string> = {
  HIGH_SUPPORT: "Extra guidance",
  STANDARD: "Standard support",
  LOW_SUPPORT: "Working independently",
};

export const DIFFICULTY_LABEL: Record<DifficultyBand, string> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
};

export const TRANSFER_LABEL: Record<TransferReadiness, string> = {
  not_attempted: "Not attempted",
  attempted: "Attempted",
  ready: "Applied successfully",
};

export const CALIBRATION_LABEL: Record<CalibrationState, string> = {
  insufficient_evidence: "Not enough data yet",
  well_calibrated: "Well calibrated",
  overconfident: "Tends to feel more confident than accuracy shows",
  underconfident: "Tends to feel less confident than accuracy shows",
};

// §11/Step 13: respectful, evidence-specific wording -- never "you don't understand X."
export const REVISION_REASON_LABEL: Record<RevisionReasonCode, string> = {
  MASTERY_DEVELOPING: "Still building mastery",
  REVIEW_DUE: "Time to refresh this",
  ACTIVE_MISCONCEPTION: "This idea may need another pass",
  PRACTICE_PLATEAU: "Recent practice has plateaued",
  PREREQUISITE_BLOCKER: "Prerequisite needed first",
  TRANSFER_NOT_DEMONSTRATED: "Ready to practice applying this",
};

// Phase 13, Step 9: a restrained "why this approach?" sentence for a personalized chat reply's
// PedagogicalReasonCode -- the same "1:1 presentation lookup, never a re-derivation" rule as every
// other label in this file. Evidence-specific, never judgmental (mirrors REVISION_REASON_LABEL's
// tone rule below).
export const PEDAGOGICAL_REASON_LABEL: Record<PedagogicalReasonCode, string> = {
  RETENTION_CRITICAL_ON_MASTERED: "You've learned this before — this is a refresher to keep it sharp.",
  PREREQUISITE_BLOCKED: "Revisiting a concept this one builds on first.",
  ACTIVE_MISCONCEPTION: "Focusing on a specific point that needs another pass.",
  INSUFFICIENT_EVIDENCE: "Getting to know where you're starting from on this topic.",
  TRANSFER_ELIGIBLE: "You've built a solid base — time to apply it in a new way.",
  TRANSFER_DEMONSTRATED: "You've shown you can apply this, so we're going deeper.",
  RECENT_ATTEMPT_INCORRECT: "Simplifying, based on your most recent attempt.",
  PRACTICE_BAND: "This is a good level to practice at right now.",
  NO_ACTIVE_CONCEPT: "General guidance — no specific concept is focused right now.",
};

// Week 4, Phase 5: a 1:1 label for the plan packer's own PlanActivityType (lib/plan/budget.ts) --
// the same "presentation lookup only, never a re-derivation" rule as every other label in this file.
export const PLAN_ACTIVITY_TYPE_LABEL: Record<PlanActivityType, string> = {
  learn: "Learn",
  review: "Review",
  practice: "Practice",
};

// The CTA button text per plan-item activity type -- kept alongside the type label above rather
// than inline in components/PlanPanel.tsx, matching this file's own "every enum -> string mapping
// lives here" convention.
export const PLAN_ACTIVITY_CTA_LABEL: Record<PlanActivityType, string> = {
  learn: "Start",
  review: "Start review",
  practice: "Practice",
};

// Week 4, Phase C -- a short verb-phrase base per agent-activity kind, for
// components/RecentActivity.tsx to build one readable sentence from (never raw JSON, never an
// internal id). NEXT_ACTION_SELECTED has no call site yet (see types/agent-activity.ts) but still
// needs a label so a future caller can't silently render "undefined" -- the same completeness
// discipline tests/ui-labels.test.ts already enforces for every other enum in this file.
export const AGENT_ACTIVITY_KIND_LABEL: Record<AgentActivityKind, string> = {
  PLAN_GENERATED: "Plan generated",
  PLAN_REPLANNED: "Plan replanned",
  NEXT_ACTION_SELECTED: "Next action selected",
  MATERIAL_GENERATED: "Study material generated",
};

// Teach-Back / Feynman Mode (final standout feature) -- a 1:1 label for the evaluator's own
// understanding categories, the same "presentation lookup only" rule as every other label here.
export const TEACH_BACK_UNDERSTANDING_LABEL: Record<TeachBackUnderstanding, string> = {
  INSUFFICIENT: "Insufficient",
  DEVELOPING: "Developing",
  STRONG: "Strong",
};

// Step 10's illustrative intent labels, mapped from the real server actions/reasons -- never
// invented independently of what the server actually returned.
export function revisionIntentLabel(reasonCodes: RevisionReasonCode[]): string {
  if (reasonCodes.includes("PREREQUISITE_BLOCKER")) return "Prerequisite needed";
  if (reasonCodes.includes("ACTIVE_MISCONCEPTION")) return "Misconception to address";
  if (reasonCodes.includes("REVIEW_DUE")) return "Review now";
  if (reasonCodes.includes("TRANSFER_NOT_DEMONSTRATED")) return "Practice application";
  if (reasonCodes.includes("PRACTICE_PLATEAU")) return "Keep practicing";
  return "Continue learning";
}
