// Learning evidence policy for Teach-Back (Phase 5 -- the most important design decision in this
// feature). Pure, deterministic, and -- in this version -- PURELY INFORMATIONAL: nothing in this
// module is ever called from a write path. No caller anywhere in lib/teach-back/* invokes
// applyLearningOutcome(), applyRetentionOutcome(), or recordScoredOutcomeWithRetention(). A
// Teach-Back attempt NEVER changes pMastery, evidenceCount, retention state, or any other
// learner-state table, regardless of the reported understanding level.
//
// WHY (audited before writing any of this feature's code):
// lib/learning/reviews.ts::recordScoredOutcomeWithRetention() -- the one trusted path that would let
// a Teach-Back result feed BKT/IRT/FSRS -- hardcodes `eventType: "QUIZ_ANSWERED"` in its call to
// recordLearningEvent(). Three options were considered:
//   A. Reuse QUIZ_ANSWERED for a Teach-Back result -- rejected: a free-text explanation is not a
//      scored quiz answer, and mislabeling it would corrupt the evidence ledger's own meaning for
//      every other consumer (analytics, revision recommendations, replay/audit).
//   B. Add a new, truthful learning_events.event_type value (e.g. TEACH_BACK_COMPLETED) via an
//      additive migration, and either generalize recordScoredOutcomeWithRetention()'s hardcoded
//      event type or duplicate its BKT+IRT+FSRS composition -- rejected: both paths touch or
//      duplicate an already-shipped, heavily-tested, heavily-depended-on function/table for a
//      feature whose grounding is inherently a looser LLM judgment than a scored quiz question
//      (which itself only reaches evidence status through lib/quiz/validate.ts's much narrower gates
//      -- exact string match for MCQ, a single bounded rubric score for short-answer).
//   C. (chosen) Treat Teach-Back as diagnostic-only in this version -- no mastery mutation at all.
//      Architectural honesty over demo spectacle, exactly as this feature's own spec asked for when
//      forced to choose.
//
// computeEvidenceEligibility() below still implements the CONSERVATIVE policy the spec sketched
// (STRONG + no unresolved questionable claims + a successfully-completed follow-up), so the
// eligibility signal exists, is deterministic, and is honestly reported to the client
// (`wouldQualifyForEvidence`) -- but it is forward-looking documentation of what a FUTURE version
// could wire up, never something this version acts on. If mastery mutation is added later, it must
// go through this exact function, not a new one invented at that call site.

import type { TeachBackUnderstanding } from "@/types/teach-back";

export interface EvidenceEligibilityInput {
  understanding: TeachBackUnderstanding;
  questionableClaims: string[];
  completedFollowUp: boolean; // true only for a final (post-follow-up) evaluation
}

export interface EvidenceEligibilityResult {
  eligible: boolean;
  reason: string;
}

export function computeEvidenceEligibility(input: EvidenceEligibilityInput): EvidenceEligibilityResult {
  if (input.understanding === "INSUFFICIENT") return { eligible: false, reason: "Understanding is insufficient." };
  if (input.understanding === "DEVELOPING") return { eligible: false, reason: "Understanding is still developing." };
  if (input.questionableClaims.length > 0) return { eligible: false, reason: "One or more questionable claims remain unresolved." };
  if (!input.completedFollowUp) return { eligible: false, reason: "The follow-up question has not been completed yet." };
  return { eligible: true, reason: "Strong understanding, no unresolved questionable claims, and the follow-up was completed." };
}
