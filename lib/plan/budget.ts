// Deterministic time-budget plan packer (Week 4, Phase 1). Pure, no I/O, no Gemini -- takes an
// ALREADY priority-ranked, ALREADY prerequisite-ordered candidate list (lib/learning/
// recommendations.ts's own contract: "priority desc, alphabetical tie-break... a blocking
// prerequisite is recommended BEFORE the concept it blocks") and fits as many of it as possible into
// a fixed time budget, without ever re-sorting, re-scoring, or re-deriving priority/order. This file
// introduces NO new learner-scoring system -- it is a pure consumer of scores/order Week 3 already
// computed, matching the repo-wide "no score soup" convention lib/learning/recommendations.ts's own
// header comment establishes.
//
// Duration is a fixed, auditable lookup by activity type (lib/plan/constants.ts), never an LLM
// judgment call and never derived from a candidate's priority score -- the planning task's own
// "Gemini never assigns a duration" boundary.

import type { RevisionReasonCode } from "@/types/progress";
import type { PlanActivityType, PlanItem } from "@/types/plan";
import { PLAN_ACTIVITY_DURATION_MINUTES, PLAN_MAX_AVAILABLE_MINUTES, PLAN_MIN_AVAILABLE_MINUTES } from "@/lib/plan/constants";

export class PlanValidationError extends Error {}

export interface PlanCandidate {
  conceptId: string;
  conceptKey: string;
  displayName: string;
  subject: string;
  reasonCodes: RevisionReasonCode[];
}

export interface PackPlanResult {
  items: PlanItem[];
  estimatedMinutes: number;
}

// Mirrors the exact priority order lib/ui/labels.ts::revisionIntentLabel() and
// components/ProgressPanel.tsx's own REASON_DISPLAY_PRIORITY already use for "which reason reads
// best," applied here to a related-but-distinct question: which single ACTIVITY TYPE this item is.
// PREREQUISITE_BLOCKER -> "learn" (something must be learned/remediated before anything else);
// REVIEW_DUE -> "review" (a retention refresh, mirrors SPACED_REVIEW); everything else -> "practice"
// (mirrors QUIZ/TRANSFER_CHALLENGE -- ordinary applied practice).
const ACTIVITY_TYPE_REASON_PRIORITY: { code: RevisionReasonCode; type: PlanActivityType }[] = [
  { code: "PREREQUISITE_BLOCKER", type: "learn" },
  { code: "REVIEW_DUE", type: "review" },
  { code: "ACTIVE_MISCONCEPTION", type: "practice" },
  { code: "TRANSFER_NOT_DEMONSTRATED", type: "practice" },
  { code: "PRACTICE_PLATEAU", type: "practice" },
  { code: "MASTERY_DEVELOPING", type: "practice" },
];

/** Pure, deterministic: one activity type per candidate, derived only from its own reasonCodes. */
export function deriveActivityType(reasonCodes: RevisionReasonCode[]): PlanActivityType {
  for (const { code, type } of ACTIVITY_TYPE_REASON_PRIORITY) {
    if (reasonCodes.includes(code)) return type;
  }
  return "practice"; // no reason code present at all -- still a real candidate, defaults to ordinary practice
}

function validateAvailableMinutes(availableMinutes: number): void {
  if (typeof availableMinutes !== "number" || !Number.isFinite(availableMinutes)) {
    throw new PlanValidationError("Available minutes must be a finite number.");
  }
  if (availableMinutes < PLAN_MIN_AVAILABLE_MINUTES || availableMinutes > PLAN_MAX_AVAILABLE_MINUTES) {
    throw new PlanValidationError(`Available minutes must be between ${PLAN_MIN_AVAILABLE_MINUTES} and ${PLAN_MAX_AVAILABLE_MINUTES}.`);
  }
}

/**
 * Fits candidates -- IN THE ORDER GIVEN, never re-sorted -- into availableMinutes.
 *
 * A candidate that would push the running total over budget STOPS the pack entirely (no
 * skip-ahead to a later, smaller candidate): skipping an earlier candidate to fit a later one could
 * seat a PREREQUISITE_REMEDIATION-blocked concept's dependent ahead of (or without) its own blocker,
 * which lib/learning/recommendations.ts's enforcePrerequisiteOrder() explicitly forbids. This is the
 * one deliberate simplification that keeps the packer a pure, order-preserving filter rather than a
 * reordering knapsack -- see tests/plan-budget.test.ts's prerequisite-ordering case for the exact
 * scenario this protects against.
 *
 * Duplicate conceptIds (e.g. the same concept surfacing in both the ranked recommendations list and
 * the separate transferPractice list) are collapsed to their first, highest-priority occurrence and
 * never stop the pack (a duplicate is skipped, not treated as a budget failure).
 */
export function packPlan(candidates: PlanCandidate[], availableMinutes: number): PackPlanResult {
  validateAvailableMinutes(availableMinutes);

  const seen = new Set<string>();
  const items: PlanItem[] = [];
  let total = 0;

  for (const candidate of candidates) {
    if (seen.has(candidate.conceptId)) continue;
    const activityType = deriveActivityType(candidate.reasonCodes);
    const estimatedMinutes = PLAN_ACTIVITY_DURATION_MINUTES[activityType];
    if (total + estimatedMinutes > availableMinutes) break;

    seen.add(candidate.conceptId);
    items.push({
      order: items.length + 1,
      conceptId: candidate.conceptId,
      conceptKey: candidate.conceptKey,
      displayName: candidate.displayName,
      subject: candidate.subject,
      activityType,
      estimatedMinutes,
      reasonCodes: candidate.reasonCodes,
    });
    total += estimatedMinutes;
  }

  return { items, estimatedMinutes: total };
}
