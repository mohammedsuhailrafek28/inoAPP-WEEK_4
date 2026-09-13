// Client-safe mirrors of the server's Phase 8-11 JSON response shapes (ARCHITECTURE.md
// §17/§21-24/§30). Pure type declarations only, no logic -- the frontend never imports from
// lib/learning/* or lib/pedagogy/* (those are "server-only"); it only knows the shape of what the
// API already decided, per Phase 12's core product principle ("frontend displays and requests;
// server decides").

export const MASTERY_STAGES = ["NEW", "LEARNING", "DEVELOPING", "PROFICIENT", "MASTERED", "REVIEW_DUE"] as const;
export type MasteryStage = (typeof MASTERY_STAGES)[number];

export type TransferReadiness = "not_attempted" | "attempted" | "ready";
export type CalibrationState = "insufficient_evidence" | "well_calibrated" | "overconfident" | "underconfident";
export type ScaffoldingLevel = "HIGH_SUPPORT" | "STANDARD" | "LOW_SUPPORT";
export type DifficultyBand = "easy" | "medium" | "hard";
export type ConceptPhase = "DIAGNOSTIC" | "INSTRUCTION" | "MAINTENANCE";

export type PedagogicalAction = "SPACED_REVIEW" | "PREREQUISITE_REMEDIATION" | "EXPLAIN" | "TRANSFER_CHALLENGE" | "DEEPEN" | "SIMPLIFY" | "QUIZ" | "HINT" | "CONTINUE";

export type RevisionReasonCode = "MASTERY_DEVELOPING" | "REVIEW_DUE" | "ACTIVE_MISCONCEPTION" | "PRACTICE_PLATEAU" | "PREREQUISITE_BLOCKER" | "TRANSFER_NOT_DEMONSTRATED";

// Client-safe mirror of lib/personalization/prompt-context.ts's PedagogicalReasonCode (itself
// mirroring types/learning.ts) -- the "why" behind a personalized chat reply's chosen teaching
// approach (Phase 13's presentation pass, Step 9). Presentation lookup only; see lib/ui/labels.ts.
export const PEDAGOGICAL_REASON_CODES = [
  "RETENTION_CRITICAL_ON_MASTERED",
  "PREREQUISITE_BLOCKED",
  "ACTIVE_MISCONCEPTION",
  "INSUFFICIENT_EVIDENCE",
  "TRANSFER_ELIGIBLE",
  "TRANSFER_DEMONSTRATED",
  "RECENT_ATTEMPT_INCORRECT",
  "PRACTICE_BAND",
  "NO_ACTIVE_CONCEPT",
] as const;
export type PedagogicalReasonCode = (typeof PEDAGOGICAL_REASON_CODES)[number];

export interface ConceptStatus {
  conceptId: string;
  conceptKey: string;
  displayName: string;
  subject: string;
  stage: MasteryStage;
  why: string[];
  evidenceCount: number;
  reviewStatus: "not_started" | "scheduled" | "due" | "overdue" | null;
  retentionUrgencyLevel: "ok" | "warning" | "critical" | null;
  transferReadiness: TransferReadiness | null;
  activeMisconception: { tag: string; description: string; evidenceCount: number } | null;
}

export interface RevisionRecommendation {
  conceptId: string;
  conceptKey: string;
  displayName: string;
  subject: string;
  priority: number;
  reasonCodes: RevisionReasonCode[];
  summary: string;
  // The concept key an intervention/recovery action should actually target (Week 4 hardening pass:
  // fixes the Progress -> Intervention mismatch). Equal to `conceptKey` for an ordinary candidate --
  // detectIntervention()'s ACTIVE_MISCONCEPTION/MASTERY_GAP triggers are evaluated on that same
  // concept. For a row inserted by recommendations.ts's prerequisite-substitution step (tagged
  // PREREQUISITE_BLOCKER), this is instead the ORIGINAL blocked concept's key -- detectIntervention's
  // PREREQUISITE_GAP trigger is defined relative to "is the target's own readiness blocked," not
  // relative to the blocker concept itself, so recovery must be invoked on the target to produce a
  // valid intervention.
  interventionConceptKey: string;
}

export interface SubjectAnalytics {
  subject: string;
  conceptsAssessed: number;
  stageCounts: Record<MasteryStage, number>;
  reviewDueCount: number;
  activeMisconceptionCount: number;
  retentionHealth: { ok: number; warning: number; critical: number };
  transferCoverage: { readyCount: number; masteredCount: number };
  autonomy: { score: number; trend: "improving" | "declining" | "stable" } | null;
  calibration: { sampleCount: number; state: CalibrationState; actionable: boolean };
  quizEvidence: { deterministic: { attempts: number; correct: number }; llmGraded: { attempts: number; correct: number } };
  recentSessionCount: number;
  concepts: ConceptStatus[];
  revisionRecommendations: RevisionRecommendation[];
  transferPractice: RevisionRecommendation[];
}

export interface ProgressOverview {
  subjects: SubjectAnalytics[];
}

export interface PedagogicalDecision {
  action: PedagogicalAction;
  targetConceptId: string;
  targetConceptKey: string;
  difficulty: DifficultyBand;
  scaffoldingLevel: ScaffoldingLevel;
  reasonCodes: string[];
  evidenceSufficient: boolean;
  explain: { focus: "misconception"; tag: string } | null;
}

export interface NextActivityResult {
  phase: ConceptPhase;
  conceptSelection: string;
  decision: PedagogicalDecision | null;
}

export interface PersonalizationMetadata {
  personalizationApplied: boolean;
  targetConceptKey: string | null;
  pedagogicalAction: PedagogicalAction | null;
  difficulty: DifficultyBand | null;
  scaffoldingLevel: ScaffoldingLevel | null;
  reasonCodes: string[] | null;
}

export type QuestionType = "mcq" | "short_answer";
export type QuizEligibleAction = "QUIZ" | "TRANSFER_CHALLENGE" | "SPACED_REVIEW" | "PREREQUISITE_REMEDIATION";

export interface QuizCitation {
  citationId: string;
  documentId: string;
  chunkId: string;
  filename: string;
  pageNumber: number;
}

export interface QuizQuestion {
  id: string;
  quizId: string;
  conceptId: string;
  questionType: QuestionType;
  questionText: string;
  options: string[] | null;
  irtDifficultyB: number;
  transferDimension: "recall" | "application" | "transfer";
  citations: QuizCitation[];
  createdAt: string;
}

export interface Quiz {
  id: string;
  studentId: string;
  sessionId: string | null;
  subject: string;
  action: QuizEligibleAction;
  targetConceptId: string;
  difficulty: DifficultyBand;
  status: "in_progress" | "submitted" | "abandoned";
  score: number | null;
  createdAt: string;
  submittedAt: string | null;
}

export type QuizGenerationResult =
  | { status: "generated"; quiz: Quiz; question: QuizQuestion; rationale: string[] }
  | { status: "not_eligible"; action: PedagogicalAction; rationale: string[] }
  | { status: "insufficient_evidence" }
  | { status: "generation_failed"; reason: string };

export interface QuizSubmissionResult {
  correct: boolean;
  score: number;
  feedback: string | null;
  quiz: Quiz;
  alreadyProcessed: boolean;
  nextActivity: NextActivityResult;
}

export interface StudentProfile {
  id: string;
  displayName: string;
  academicLevel: string;
  subjects: string[];
  learningGoals: string | null;
  preferredExplanationStyle: "simple" | "detailed" | "exam";
  preferredDifficulty: "auto" | "easy" | "medium" | "hard";
  preferredPace: "self-paced" | "standard" | "accelerated";
  examplePreference: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConceptSummary {
  id: string;
  conceptKey: string;
  displayName: string;
  subject: string;
}
