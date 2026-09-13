// Autonomy / Scaffolding (ARCHITECTURE.md §15, Phase 7) -- "how independently can this
// learner currently work?" NOT intelligence, mastery, confidence, ability, or personality (Step 3).
// Consumes BKT/calibration/FSRS/event evidence; never replaces them (Step 2).
//
// §15 is the ONE place in this codebase that locks a weighted-average "score" across signals --
// every other subsystem (BKT/IRT/FSRS/readiness/transfer/calibration) deliberately never averages
// (Step 6). This is not an exception to that discipline, it's the literal architecture: the
// formula below is ported verbatim, not invented.
//
// autonomyScore = (initiativeRate + calibrationAccuracy + hintIndependence + proactiveReviewRate) / 4
// Scaffolding tier = SCAFFOLDING_TIER_BOUNDS (0.3/0.7) applied to the score, then shifted ONE tier
// in the trend's direction (clamped at the ends) -- this IS the anti-oscillation mechanism Step 7
// asks for: trend only moves after >=6 historical (session-level) scores and compares a 5-score
// mean against a prior mean, so one anomalous session can't flip the tier back and forth. No
// separate cooldown/hysteresis layer is added on top -- that would be inventing a second mechanism
// where the locked one already does the job.

import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { LEARNING_CONFIG } from "@/lib/learning/constants";
import { getCalibrationSignal } from "@/lib/learning/calibration";
import type { AutonomyComponents, AutonomySnapshot, AutonomyTrend, ScaffoldingDecision, ScaffoldingLevel, ScaffoldingReasonCode } from "@/types/learning";

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

const TIER_BOUNDS = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.SCAFFOLDING_TIER_BOUNDS.value;
const TREND_MIN_HISTORY = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.AUTONOMY_TREND_MIN_HISTORY.value;
const TREND_WINDOW = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.AUTONOMY_TREND_WINDOW.value;
const TREND_DELTA = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.AUTONOMY_TREND_DELTA.value;
const MASTERY_ACHIEVED_THRESHOLD = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.MASTERY_ACHIEVED_THRESHOLD.value;
const MIN_EVIDENCE_FOR_ADAPTIVE = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.MIN_EVIDENCE_FOR_ADAPTIVE.value;

const LEVEL_ORDER: ScaffoldingLevel[] = ["HIGH_SUPPORT", "STANDARD", "LOW_SUPPORT"];
const MAX_SESSIONS_CONSIDERED = 50; // a defensive bound on history replay, not a policy threshold -- matches events.ts's own local-bound convention

export interface AutonomyDependencies {
  supabase?: SupabaseClient;
}

/** §15's exact four-component average -- pure. */
export function computeAutonomyScore(components: AutonomyComponents): number {
  return (components.initiativeRate + components.calibrationAccuracy + components.hintIndependence + components.proactiveReviewRate) / 4;
}

/**
 * §15's trend rule: fewer than AUTONOMY_TREND_MIN_HISTORY (6) scores -> 'stable'. Otherwise compare
 * the mean of the newest AUTONOMY_TREND_WINDOW (5) scores against the mean of the prior scores
 * (everything before that window, itself capped at 5) -- the only reading of "compares mean of
 * newest 5 vs. prior 5" that is consistent with "needs >= 6" (5 newest + as few as 1 prior).
 * `scores` is ordered oldest -> newest.
 */
export function computeAutonomyTrend(scores: number[]): AutonomyTrend {
  if (scores.length < TREND_MIN_HISTORY) return "stable";
  const newest = scores.slice(-TREND_WINDOW);
  const prior = scores.slice(0, -TREND_WINDOW).slice(-TREND_WINDOW);
  const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
  const diff = mean(newest) - mean(prior);
  if (diff > TREND_DELTA) return "improving";
  if (diff < -TREND_DELTA) return "declining";
  return "stable";
}

function baseScaffoldingLevel(score: number): ScaffoldingLevel {
  if (score < TIER_BOUNDS.highSupportMax) return "HIGH_SUPPORT";
  if (score < TIER_BOUNDS.lowSupportMin) return "STANDARD";
  return "LOW_SUPPORT";
}

/** Shifts one tier toward LOW_SUPPORT (improving) or HIGH_SUPPORT (declining), clamped at the ends -- pure. */
export function shiftScaffoldingLevel(base: ScaffoldingLevel, trend: AutonomyTrend): ScaffoldingLevel {
  const index = LEVEL_ORDER.indexOf(base);
  if (trend === "improving") return LEVEL_ORDER[Math.min(LEVEL_ORDER.length - 1, index + 1)];
  if (trend === "declining") return LEVEL_ORDER[Math.max(0, index - 1)];
  return base;
}

/** §15's full deterministic decision, pure -- score + trend in, tier + interpretable reasons out. */
export function decideScaffolding(score: number, trend: AutonomyTrend): { level: ScaffoldingLevel; baseLevel: ScaffoldingLevel; reasonCodes: ScaffoldingReasonCode[] } {
  const baseLevel = baseScaffoldingLevel(score);
  const level = shiftScaffoldingLevel(baseLevel, trend);
  const reasonCodes: ScaffoldingReasonCode[] = [baseLevel === "HIGH_SUPPORT" ? "AUTONOMY_LOW" : baseLevel === "STANDARD" ? "AUTONOMY_STANDARD" : "AUTONOMY_HIGH"];
  if (level !== baseLevel) reasonCodes.push(trend === "improving" ? "TREND_SHIFTED_UP" : "TREND_SHIFTED_DOWN");
  return { level, baseLevel, reasonCodes };
}

interface SessionWindow {
  id: string;
  startedAt: string;
  endedAt: string;
}

async function getEndedSessions(studentId: string, supabase: SupabaseClient): Promise<SessionWindow[]> {
  const { data, error } = await supabase.from("learning_sessions").select().eq("student_id", studentId).eq("status", "ended").order("started_at", { ascending: true });
  if (error) throw new Error("Could not load session history.");
  return ((data ?? []) as Record<string, unknown>[])
    .filter((row) => row.ended_at != null)
    .slice(-MAX_SESSIONS_CONSIDERED)
    .map((row) => ({ id: row.id as string, startedAt: row.started_at as string, endedAt: row.ended_at as string }));
}

/** initiativeRate for one session: self-initiated QUESTION_ASKED / total QUESTION_ASKED in that session. Null when the session asked no questions at all (excluded from the "vacuous default" convention -- see computeSessionAutonomy). */
async function initiativeRateForSession(sessionId: string, supabase: SupabaseClient): Promise<number | null> {
  const { data, error } = await supabase.from("learning_events").select().eq("session_id", sessionId).eq("event_type", "QUESTION_ASKED");
  if (error) throw new Error("Could not load question events for this session.");
  const rows = (data ?? []) as Record<string, unknown>[];
  if (rows.length === 0) return null;
  const selfInitiated = rows.filter((row) => (row.metadata as { selfInitiated?: boolean } | null)?.selfInitiated === true).length;
  return selfInitiated / rows.length;
}

/** hintIndependence for one session: 1 - hints/total on concepts already at MASTERY_ACHIEVED_THRESHOLD, scoped to that session's window. */
async function hintIndependenceForSession(studentId: string, session: SessionWindow, supabase: SupabaseClient): Promise<number> {
  const { data, error } = await supabase.from("learning_events").select().eq("session_id", session.id);
  if (error) throw new Error("Could not load events for this session.");
  const relevant = ((data ?? []) as Record<string, unknown>[]).filter((row) => (row.event_type === "QUIZ_ANSWERED" || row.event_type === "HINT_REQUESTED") && row.concept_id != null);
  if (relevant.length === 0) return 1; // no evidence of dependency -- neutral-favorable default, matching every other vacuous-evidence case in this codebase

  const conceptIds = [...new Set(relevant.map((row) => row.concept_id as string))];
  const masteredConceptIds = new Set<string>();
  for (const conceptId of conceptIds) {
    const { data: stateRow } = await supabase.from("learner_concept_state").select().eq("student_id", studentId).eq("concept_id", conceptId).maybeSingle();
    if (stateRow && (stateRow.p_mastery as number) >= MASTERY_ACHIEVED_THRESHOLD) masteredConceptIds.add(conceptId);
  }
  const onMastered = relevant.filter((row) => masteredConceptIds.has(row.concept_id as string));
  if (onMastered.length === 0) return 1;
  const hints = onMastered.filter((row) => row.event_type === "HINT_REQUESTED").length;
  return 1 - Math.min(hints / onMastered.length, 1);
}

/**
 * proactiveReviewRate for one session: among this session's own FSRS retention transitions that
 * are NOT a concept's first-ever review (a first review has no prior due date to compare against),
 * the fraction reviewed at or before the prior transition's own next_review_at.
 */
async function proactiveReviewRateForSession(studentId: string, session: SessionWindow, supabase: SupabaseClient): Promise<number> {
  // learner_retention_transitions has no session_id column -- scoped by reviewed_at falling inside
  // this session's time window instead, mirroring how episodic memory derives concepts_touched
  // from event timestamps rather than a denormalized column.
  const { data, error } = await supabase.from("learner_retention_transitions").select().eq("student_id", studentId);
  if (error) throw new Error("Could not load retention transitions.");
  const allTransitions = (data ?? []) as Record<string, unknown>[];

  const byConcept = new Map<string, Record<string, unknown>[]>();
  for (const row of allTransitions) {
    const conceptId = row.concept_id as string;
    if (!byConcept.has(conceptId)) byConcept.set(conceptId, []);
    byConcept.get(conceptId)!.push(row);
  }

  let proactive = 0;
  let total = 0;
  for (const transitions of byConcept.values()) {
    transitions.sort((a, b) => new Date(a.created_at as string).getTime() - new Date(b.created_at as string).getTime());
    for (let i = 1; i < transitions.length; i++) {
      const reviewedAt = new Date(transitions[i].reviewed_at as string);
      if (reviewedAt < new Date(session.startedAt) || reviewedAt > new Date(session.endedAt)) continue; // scope to this session's window
      total += 1;
      const priorDue = new Date(transitions[i - 1].next_review_at as string);
      if (reviewedAt.getTime() <= priorDue.getTime()) proactive += 1;
    }
  }
  if (total === 0) return 1; // no reviews-with-a-known-due-date this session -- neutral-favorable default
  return proactive / total;
}

/** One session's full AutonomyComponents, or null if the session had no real learning evidence at all (Step 23's empty-session principle, applied to autonomy). */
async function computeSessionAutonomy(studentId: string, session: SessionWindow, supabase: SupabaseClient): Promise<AutonomyComponents | null> {
  const initiativeRate = await initiativeRateForSession(session.id, supabase);
  const { data: scoredEvents, error } = await supabase.from("learning_events").select().eq("session_id", session.id).eq("event_type", "QUIZ_ANSWERED");
  if (error) throw new Error("Could not load scored events for this session.");
  const hasScoredEvidence = ((scoredEvents ?? []) as unknown[]).length > 0;
  if (initiativeRate === null && !hasScoredEvidence) return null; // nothing meaningful happened this session

  const calibration = await getCalibrationSignal(studentId, { supabase });
  const calibrationAccuracy = calibration.bias === null ? 1 : 1 - Math.min(Math.abs(calibration.bias), 1);
  const hintIndependence = await hintIndependenceForSession(studentId, session, supabase);
  const proactiveReviewRate = await proactiveReviewRateForSession(studentId, session, supabase);

  return { initiativeRate: initiativeRate ?? 1, calibrationAccuracy, hintIndependence, proactiveReviewRate };
}

/**
 * The full, DB-backed autonomy snapshot: one score per ended session with real evidence (oldest ->
 * newest), the latest of which is "the current score," plus the trend over that whole sequence.
 * No Gemini anywhere in this file.
 */
export async function getAutonomySnapshot(studentId: string, dependencies: AutonomyDependencies = {}): Promise<AutonomySnapshot | null> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const sessions = await getEndedSessions(studentId, supabase);

  const scores: number[] = [];
  let latestComponents: AutonomyComponents | null = null;
  for (const session of sessions) {
    const components = await computeSessionAutonomy(studentId, session, supabase);
    if (!components) continue;
    scores.push(computeAutonomyScore(components));
    latestComponents = components; // sessions are oldest -> newest, so the last one written wins
  }
  if (scores.length === 0 || !latestComponents) return null;

  return { studentId, score: scores[scores.length - 1], components: latestComponents, trend: computeAutonomyTrend(scores), historicalScoreCount: scores.length };
}

/** The Step 5/6 read contract: derives the current scaffolding decision from the autonomy snapshot. Evidence-gated (Step 4/38): below MIN_EVIDENCE_FOR_ADAPTIVE total ended sessions with evidence, pin to STANDARD rather than reacting to one session. */
export async function getScaffoldingDecision(studentId: string, dependencies: AutonomyDependencies = {}): Promise<ScaffoldingDecision> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const autonomy = await getAutonomySnapshot(studentId, { supabase });
  if (!autonomy || autonomy.historicalScoreCount < MIN_EVIDENCE_FOR_ADAPTIVE) {
    return { level: "STANDARD", baseLevel: "STANDARD", reasonCodes: ["INSUFFICIENT_EVIDENCE"], evidenceSufficient: false, autonomy: autonomy ?? null };
  }
  const { level, baseLevel, reasonCodes } = decideScaffolding(autonomy.score, autonomy.trend);
  return { level, baseLevel, reasonCodes, evidenceSufficient: true, autonomy };
}
