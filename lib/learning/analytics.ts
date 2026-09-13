// Learning analytics (ARCHITECTURE.md §24, Phase 11). Module path matches the architecture's
// own exact module list (§29: "analytics.ts aggregates (§24)").
//
// Every metric below is "traceable to a query" (§24's own requirement) -- nothing here fabricates
// study hours, improvement, consistency, or confidence trends beyond what stored evidence
// literally supports (Step 24). "Learning trend" (Step 27) deliberately reuses §15's own autonomy
// trend (already a real, historically-windowed, minimum-sample-gated computation) rather than
// inventing a second, parallel trend metric from a different signal -- §24's own metric list
// already names "Autonomy score + trend" as the one trend metric this subsystem tracks.

import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { listConceptsBySubject } from "@/lib/learning/concepts";
import { getConceptStatus, type ConceptStatus, type MasteryStage, MASTERY_STAGES } from "@/lib/learning/olm";
import { getAutonomySnapshot } from "@/lib/learning/autonomy";
import { getCalibrationSignal } from "@/lib/learning/calibration";
import { getRevisionRecommendations, type RevisionRecommendation } from "@/lib/learning/recommendations";
import type { AutonomySnapshot, CalibrationSignal, RetentionUrgencyLevel } from "@/types/learning";

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

// §28: "use server/DB timestamps... if architecture defines 7-day/recent-session windows, use
// those; otherwise do not invent arbitrary 'weekly improvement' analytics." §24 defines no
// specific window, so this file limits itself to counting real, server-timestamped, MEANINGFUL
// (non-empty) ended sessions within a fixed, documented 7-day lookback -- a plain activity count,
// never an "improvement" or "consistency" claim the stored evidence doesn't support.
const RECENT_ACTIVITY_WINDOW_DAYS = 7;

export interface RetentionHealthCounts {
  ok: number;
  warning: number;
  critical: number;
}

export interface TransferCoverage {
  readyCount: number;
  masteredCount: number;
}

export interface QuizEvidenceSummary {
  deterministic: { attempts: number; correct: number }; // MCQ, §32: "Deterministic string compare"
  llmGraded: { attempts: number; correct: number }; // short-answer, Gemini-assisted grading (§32/§33)
}

export interface SubjectAnalytics {
  subject: string;
  conceptsAssessed: number; // evidence_count > 0 -- NOT the same as "total concepts registered" (Step 4/12: no evidence != NEW, not weak, and not "assessed")
  stageCounts: Record<MasteryStage, number>;
  reviewDueCount: number;
  activeMisconceptionCount: number;
  retentionHealth: RetentionHealthCounts;
  transferCoverage: TransferCoverage;
  autonomy: AutonomySnapshot | null; // null exactly when getAutonomySnapshot() itself reports insufficient evidence -- reuses Phase 7's own threshold, no second "analytics minimum" invented (Step 5)
  calibration: CalibrationSignal; // already internally gated to 'insufficient_evidence' below CALIBRATION_MIN_SAMPLES (§13, Step 7)
  quizEvidence: QuizEvidenceSummary;
  recentSessionCount: number; // meaningful (non-empty) ended sessions in the last RECENT_ACTIVITY_WINDOW_DAYS, server-timestamped
  concepts: ConceptStatus[]; // per-concept summaries (Step 25), reused verbatim from lib/learning/olm.ts
  revisionRecommendations: RevisionRecommendation[]; // delegated, never recomputed here (Step 33: "keep progress description separate from revision ordering")
  transferPractice: RevisionRecommendation[];
}

export interface AnalyticsDependencies {
  supabase?: SupabaseClient;
  now?: Date;
}

function emptyStageCounts(): Record<MasteryStage, number> {
  return Object.fromEntries(MASTERY_STAGES.map((stage) => [stage, 0])) as Record<MasteryStage, number>;
}

function retentionUrgencyBucket(level: RetentionUrgencyLevel | null, counts: RetentionHealthCounts): void {
  if (level === "critical") counts.critical += 1;
  else if (level === "warning") counts.warning += 1;
  else if (level === "ok") counts.ok += 1;
}

async function getQuizEvidenceSummary(studentId: string, subject: string, supabase: SupabaseClient): Promise<QuizEvidenceSummary> {
  const { data: quizRows, error: quizError } = await supabase.from("quizzes").select("id").eq("student_id", studentId).eq("subject", subject);
  if (quizError) throw new Error("Could not load quiz history for analytics.");
  const quizIds = new Set(((quizRows ?? []) as Record<string, unknown>[]).map((row) => row.id as string));
  if (quizIds.size === 0) return { deterministic: { attempts: 0, correct: 0 }, llmGraded: { attempts: 0, correct: 0 } };

  const { data: answerRows, error: answerError } = await supabase.from("quiz_answers").select().eq("student_id", studentId);
  if (answerError) throw new Error("Could not load quiz answers for analytics.");

  const summary: QuizEvidenceSummary = { deterministic: { attempts: 0, correct: 0 }, llmGraded: { attempts: 0, correct: 0 } };
  for (const row of (answerRows ?? []) as Record<string, unknown>[]) {
    if (!quizIds.has(row.quiz_id as string)) continue;
    // §31: provenance preserved, never blended -- an evidence_trust value this file doesn't
    // recognize is neither counted as deterministic nor as llm_graded, rather than silently
    // guessed into one bucket.
    const bucket = row.evidence_trust === "deterministic" ? summary.deterministic : row.evidence_trust === "llm_graded" ? summary.llmGraded : null;
    if (!bucket) continue;
    bucket.attempts += 1;
    if (row.correct === true) bucket.correct += 1;
  }
  return summary;
}

async function getRecentSessionCount(studentId: string, subject: string, now: Date, supabase: SupabaseClient): Promise<number> {
  const since = new Date(now.getTime() - RECENT_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const { data, error } = await supabase.from("learning_sessions").select().eq("student_id", studentId).eq("subject", subject).eq("status", "ended");
  if (error) throw new Error("Could not load session history for analytics.");
  // "Meaningful" per Step 29/§23: a session with concepts_touched is real activity; New Chat
  // (which touches zero learning-evidence tables) never creates such a session in the first place,
  // so it is structurally excluded here too, not filtered by a special case.
  return ((data ?? []) as Record<string, unknown>[]).filter((row) => {
    const startedAt = new Date(row.started_at as string);
    const touched = Array.isArray(row.concepts_touched) ? (row.concepts_touched as string[]) : [];
    return startedAt >= since && touched.length > 0;
  }).length;
}

/**
 * The Step 26/32 subject-summary entry point. Read-only, never persisted (mirrors §23's own "not
 * persisted -- computed on demand" reasoning, and Step 40's "prefer no migration").
 */
export async function getSubjectAnalytics(studentId: string, subject: string, dependencies: AnalyticsDependencies = {}): Promise<SubjectAnalytics> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const now = dependencies.now ?? new Date();

  const concepts = await listConceptsBySubject(subject, { supabase });
  const statuses = await Promise.all(concepts.map((concept) => getConceptStatus(studentId, concept.id, { supabase, now })));

  const stageCounts = emptyStageCounts();
  const retentionHealth: RetentionHealthCounts = { ok: 0, warning: 0, critical: 0 };
  let conceptsAssessed = 0;
  let reviewDueCount = 0;
  let activeMisconceptionCount = 0;
  let masteredCount = 0;
  let transferReadyCount = 0;

  for (const status of statuses) {
    stageCounts[status.stage] += 1;
    if (status.evidenceCount > 0) conceptsAssessed += 1;
    if (status.stage === "REVIEW_DUE") reviewDueCount += 1;
    if (status.activeMisconception) activeMisconceptionCount += 1;
    if (status.stage === "MASTERED") {
      masteredCount += 1;
      if (status.transferReadiness === "ready") transferReadyCount += 1;
    }
  }

  // Retention health (§24: "count of concepts by urgency tier, §10.3") -- the REAL 3-tier urgency,
  // a different axis from `stage` (a concept can be retention-"warning" while its OLM stage is
  // still e.g. DEVELOPING; only the narrower, stage-overriding REVIEW_DUE threshold is 0.40).
  // Concepts with no retention state at all (never reviewed) are excluded, not counted as "ok".
  for (const status of statuses) {
    retentionUrgencyBucket(status.retentionUrgencyLevel, retentionHealth);
  }

  const [autonomy, calibration, quizEvidence, recentSessionCount, revision] = await Promise.all([
    getAutonomySnapshot(studentId, { supabase }),
    getCalibrationSignal(studentId, { supabase }),
    getQuizEvidenceSummary(studentId, subject, supabase),
    getRecentSessionCount(studentId, subject, now, supabase),
    getRevisionRecommendations(studentId, { subject }, { supabase, now }),
  ]);

  return {
    subject,
    conceptsAssessed,
    stageCounts,
    reviewDueCount,
    activeMisconceptionCount,
    retentionHealth,
    transferCoverage: { readyCount: transferReadyCount, masteredCount },
    autonomy,
    calibration,
    quizEvidence,
    recentSessionCount,
    concepts: statuses,
    revisionRecommendations: revision.recommendations,
    transferPractice: revision.transferPractice,
  };
}
