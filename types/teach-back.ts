// Teach-Back / Feynman Mode (final standout feature). Client-safe: no server-only import, mirroring
// every other types/*.ts split in this app. Citations reuse types/progress.ts's existing
// QuizCitation shape verbatim -- never a second citation type.
//
// ARCHITECTURAL DECISION (locked after auditing lib/learning/reviews.ts::recordScoredOutcomeWithRetention(),
// which hardcodes eventType: "QUIZ_ANSWERED"): Teach-Back is DIAGNOSTIC ONLY in this version. It never
// mutates mastery, retention, or any learner-state table. Reusing QUIZ_ANSWERED would misrepresent
// what happened (a free-text explanation is not a scored quiz answer); adding a new learning_events
// CHECK-constraint value would touch the same already-shipped, heavily-consumed table BKT/IRT/FSRS/
// PFA all read from, for a feature whose evaluation is inherently harder to defend as authoritative
// evidence than a quiz answer. See lib/teach-back/evidence-policy.ts for the full reasoning --
// `wouldQualifyForEvidence` below is informational/forward-looking only, never wired to a write path.

import type { QuizCitation } from "@/types/progress";

export const TEACH_BACK_UNDERSTANDING_LEVELS = ["INSUFFICIENT", "DEVELOPING", "STRONG"] as const;
export type TeachBackUnderstanding = (typeof TEACH_BACK_UNDERSTANDING_LEVELS)[number];

export interface TeachBackEvaluation {
  conceptId: string;
  conceptKey: string;
  conceptDisplayName: string;
  understanding: TeachBackUnderstanding;
  strengths: string[]; // what the learner explained correctly
  missingIdeas: string[]; // important ideas they did not mention
  questionableClaims: string[]; // claims that may be incorrect, per the grounded source material
  followUpQuestion: string; // probes the largest gap, or a transfer/application question when understanding is STRONG
  citations: QuizCitation[];
  generatedAt: string;
}

export interface TeachBackFollowUpResult {
  conceptId: string;
  conceptKey: string;
  conceptDisplayName: string;
  understanding: TeachBackUnderstanding;
  strengths: string[];
  missingIdeas: string[];
  questionableClaims: string[];
  citations: QuizCitation[];
  // Informational only (lib/teach-back/evidence-policy.ts's conservative, never-applied policy) --
  // NOT a claim that any learner-state table was updated. See this file's header comment.
  wouldQualifyForEvidence: boolean;
  generatedAt: string;
}

export interface TeachBackEvaluateRequest {
  conceptKey: string;
  documentIds: string[];
  explanation: string;
}

export interface TeachBackFollowUpRequest {
  conceptKey: string;
  documentIds: string[];
  originalExplanation: string;
  followUpQuestion: string;
  followUpAnswer: string;
}

export type TeachBackEvaluateResult =
  | { status: "evaluated"; evaluation: TeachBackEvaluation }
  | { status: "insufficient_evidence" }
  | { status: "generation_failed"; reason: string };

export type TeachBackFollowUpEvaluateResult =
  | { status: "evaluated"; result: TeachBackFollowUpResult }
  | { status: "insufficient_evidence" }
  | { status: "generation_failed"; reason: string };
