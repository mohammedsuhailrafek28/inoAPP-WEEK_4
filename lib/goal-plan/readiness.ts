// Exam readiness (standout feature, Phase 2). Pure, no I/O -- takes the ALREADY-computed
// SubjectAnalytics (lib/learning/analytics.ts::getSubjectAnalytics(), reused verbatim, never
// recomputed) and derives ONE restrained, explainable percentage from it.
//
// Deliberately NOT a weighted blend of mastery + retention + misconceptions + transfer coverage
// ("score soup," explicitly ruled out by this feature's own spec). The only input is
// `stageCounts` -- a categorical field (lib/learning/olm.ts::MasteryStage) already computed,
// already tested, and already shown to the learner on the Progress panel. readyPercent is nothing
// more than "what fraction of this subject's concepts are already at MASTERED or PROFICIENT,"
// expressed as a percentage -- fully reconstructable by a human counting badges on the existing
// Progress screen.
//
// REVIEW_DUE is deliberately EXCLUDED from "ready": a concept flagged review-due represents a real,
// current gap (retention has measurably dropped since it was last practiced) -- conservatively not
// counted as exam-ready without a refresh. Its count is surfaced separately (never blended into the
// percentage), which is exactly the signal that makes such a concept a REVIEW-type roadmap item.

import type { SubjectAnalytics } from "@/lib/learning/analytics";
import type { ExamReadiness } from "@/types/goal-plan";

// Presentation-only banding of readyPercent into a restrained headline word. Not a new learner
// model threshold -- purely a display convenience, the same category of choice as
// lib/plan/constants.ts's own duration policy (fixed, documented, never Gemini-assigned).
const READY_CATEGORY_MIN_PERCENT = 75;
const DEVELOPING_CATEGORY_MIN_PERCENT = 40;

export function computeExamReadiness(analytics: SubjectAnalytics): ExamReadiness {
  const readyConceptCount = analytics.stageCounts.MASTERED + analytics.stageCounts.PROFICIENT;
  const totalConceptCount = analytics.concepts.length;
  const readyPercent = totalConceptCount === 0 ? 0 : Math.round((readyConceptCount / totalConceptCount) * 100);

  const category = readyPercent >= READY_CATEGORY_MIN_PERCENT ? "READY" : readyPercent >= DEVELOPING_CATEGORY_MIN_PERCENT ? "DEVELOPING" : "LOW";

  return {
    readyConceptCount,
    totalConceptCount,
    readyPercent,
    reviewDueCount: analytics.stageCounts.REVIEW_DUE,
    activeMisconceptionCount: analytics.activeMisconceptionCount,
    category,
  };
}
