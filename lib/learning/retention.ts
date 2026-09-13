// FSRS-style retention/review scheduling -- pure, deterministic, no I/O (ARCHITECTURE.md §10).
//
// A RETENTION/SCHEDULING model, not another mastery model. BKT P(Forget) stays inside BKT's own
// mathematical knowledge-state transition and is never applied again here as elapsed-time decay;
// nothing in this file ever reads or writes p_mastery/theta, and nothing here is ever averaged with
// them. A concept can have high BKT mastery and a due FSRS review at the same time -- that means
// "evidence suggests the concept was learned, but memory reinforcement is due," not "reduce mastery
// because time passed" (§10's explicit boundary).
//
// Formulas ported verbatim from the Open-Spaced-Repetition project's own published defaults (§10.2),
// simplified exactly as the locked doc specifies: only Good/Again ratings exist (Hard/Easy dropped,
// "the audit confirmed Tutor MCP's own live traffic never actually drives those two paths either"),
// and retention_difficulty is set once at a card's first review and held fixed thereafter -- §10.2
// gives no "next difficulty" formula for later reviews, so none is invented here (Step 4: "do not
// silently substitute ... a simplified home-grown scheduler unless the architecture explicitly
// specifies such a simplification" -- fixing difficulty after init IS that explicit simplification,
// dropping it back to a home-grown recompute would not be).
//
// card_state ∈ {new, learning, review, relearning} (§10.1) drives which branch below applies. "new"
// is a virtual state used only for dispatch here -- a persisted learner_concept_state row is never
// actually written with card_state='new' by this phase's write path (lib/learning/reviews.ts only
// creates a row on a real first review, Step 13), so `applyReview(null, ...)` stands in for it.

import { LEARNING_CONFIG } from "@/lib/learning/constants";
import type { CardState, RetentionRating, RetentionUrgency, RetentionUrgencyLevel, ReviewStatus } from "@/types/learning";

export class RetentionConfigError extends Error {}

const W = LEARNING_CONFIG.MODEL_PARAMETERS.FSRS_WEIGHTS.value;
const FACTOR = LEARNING_CONFIG.MODEL_PARAMETERS.FSRS_FACTOR.value;
const DECAY = LEARNING_CONFIG.MODEL_PARAMETERS.FSRS_DECAY.value;
const DESIRED_RETENTION = LEARNING_CONFIG.MODEL_PARAMETERS.FSRS_DESIRED_RETENTION.value;
const STABILITY_DIFFICULTY_FLOOR = LEARNING_CONFIG.SAFETY_CLAMPS.FSRS_STABILITY_DIFFICULTY_FLOOR.value;
const DIFFICULTY_BOUNDS = LEARNING_CONFIG.SAFETY_CLAMPS.FSRS_DIFFICULTY_BOUNDS.value;
const MIN_INTERVAL_DAYS = LEARNING_CONFIG.SAFETY_CLAMPS.FSRS_MIN_INTERVAL_DAYS.value;
const URGENCY_WARNING_MAX = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.RETENTION_URGENCY_WARNING_MAX.value;
const URGENCY_CRITICAL_MAX = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.RETENTION_URGENCY_CRITICAL_MAX.value;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function floorPositive(value: number): number {
  return Math.max(value, STABILITY_DIFFICULTY_FLOOR);
}

function clampDifficulty(value: number): number {
  return Math.min(DIFFICULTY_BOUNDS.max, Math.max(DIFFICULTY_BOUNDS.min, value));
}

function validateRating(rating: RetentionRating): void {
  if (rating !== "again" && rating !== "good") throw new RetentionConfigError(`Rating must be 'again' or 'good', got ${String(rating)}.`);
}

function validateStability(stability: number, label = "stability"): void {
  if (!isFiniteNumber(stability) || stability <= 0) throw new RetentionConfigError(`${label} must be a finite positive number, got ${stability}.`);
}

function validateDifficulty(difficulty: number, label = "difficulty"): void {
  if (!isFiniteNumber(difficulty) || difficulty < DIFFICULTY_BOUNDS.min || difficulty > DIFFICULTY_BOUNDS.max) {
    throw new RetentionConfigError(`${label} must be a finite number in [${DIFFICULTY_BOUNDS.min}, ${DIFFICULTY_BOUNDS.max}], got ${difficulty}.`);
  }
}

function validateElapsedDays(elapsedDays: number): void {
  if (!isFiniteNumber(elapsedDays) || elapsedDays < 0) throw new RetentionConfigError(`Elapsed days must be a finite, non-negative number, got ${elapsedDays}.`);
}

/** Days elapsed between two authoritative (server-controlled) timestamps -- never negative; a negative gap is a real bug, not silently floored. */
export function daysBetween(earlier: Date, later: Date): number {
  const raw = (later.getTime() - earlier.getTime()) / MS_PER_DAY;
  if (raw < 0) throw new RetentionConfigError(`Elapsed time cannot be negative: ${earlier.toISOString()} is after ${later.toISOString()}.`);
  return raw;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

/**
 * retrievability(elapsedDays, stability) = (1 + FACTOR*elapsedDays/stability) ^ DECAY, stability
 * floored at 1e-9 (§10.2, ported verbatim). elapsedDays=0 always yields exactly 1 (just reviewed).
 */
export function calculateRetrievability(elapsedDays: number, stability: number): number {
  validateElapsedDays(elapsedDays);
  if (!isFiniteNumber(stability)) throw new RetentionConfigError(`Stability must be a finite number, got ${stability}.`);
  const safeStability = floorPositive(stability);
  return Math.pow(1 + (FACTOR * elapsedDays) / safeStability, DECAY);
}

/** initialStability(Good) = w2, initialStability(Again) = w0 (§10.2). */
export function initialStability(rating: RetentionRating): number {
  validateRating(rating);
  return rating === "good" ? W.w2 : W.w0;
}

/**
 * initialDifficulty(r) = clamp(w4 - exp(w5*(r-1)) + 1, 1, 10) (§10.2). `r` uses FSRS's own 4-point
 * rating scale (Again=1, Good=3) even though Hard=2/Easy=4 are never produced -- this is the exact
 * formula the published weights were fit against, not a re-derivation.
 */
export function initialDifficulty(rating: RetentionRating): number {
  validateRating(rating);
  const r = rating === "good" ? 3 : 1;
  return clampDifficulty(W.w4 - Math.exp(W.w5 * (r - 1)) + 1);
}

/** Next stability on a successful (Good) review: S' = S*(exp(w8)*(11-D)*S^-w9*(exp(w10*(1-R))-1) + 1) (§10.2). */
export function nextStabilityOnSuccess(stability: number, difficulty: number, retrievability: number): number {
  validateStability(stability);
  validateDifficulty(difficulty);
  if (!isFiniteNumber(retrievability) || retrievability < 0 || retrievability > 1) {
    throw new RetentionConfigError(`Retrievability must be a finite number in [0, 1], got ${retrievability}.`);
  }
  const s = floorPositive(stability);
  const d = floorPositive(difficulty);
  const growth = Math.exp(W.w8) * (11 - d) * Math.pow(s, -W.w9) * (Math.exp(W.w10 * (1 - retrievability)) - 1);
  return s * (growth + 1);
}

/** Next stability on a lapse (Again, from `review` state): S_forget = w11*D^-w12*((S+1)^w13-1)*exp(w14*(1-R)) (§10.2). */
export function nextStabilityOnLapse(stability: number, difficulty: number, retrievability: number): number {
  validateStability(stability);
  validateDifficulty(difficulty);
  if (!isFiniteNumber(retrievability) || retrievability < 0 || retrievability > 1) {
    throw new RetentionConfigError(`Retrievability must be a finite number in [0, 1], got ${retrievability}.`);
  }
  const s = floorPositive(stability);
  const d = floorPositive(difficulty);
  return W.w11 * Math.pow(d, -W.w12) * (Math.pow(s + 1, W.w13) - 1) * Math.exp(W.w14 * (1 - retrievability));
}

/**
 * nextIntervalDays = max(1, round(S/FACTOR * (desiredRetention^(1/DECAY) - 1))) (§10.2). With the
 * locked DESIRED_RETENTION=0.9/FACTOR=19/81/DECAY=-0.5, `(0.9^(1/-0.5) - 1)` algebraically equals
 * FACTOR exactly (1/0.81 - 1 = 0.19/0.81 = 19/81), so this reduces to max(1, round(S)) for the
 * locked constants -- implemented as the literal formula, not that reduction, so it stays correct
 * if any of the three constants ever changes.
 */
export function nextIntervalDays(stability: number): number {
  validateStability(stability);
  const s = floorPositive(stability);
  const raw = (s / FACTOR) * (Math.pow(DESIRED_RETENTION, 1 / DECAY) - 1);
  return Math.max(MIN_INTERVAL_DAYS, Math.round(raw));
}

/** §10.3's three-tier retention urgency, reusing the FORGETTING alert's own numbers. */
export function getRetentionUrgency(retrievability: number): RetentionUrgency {
  if (!isFiniteNumber(retrievability) || retrievability < 0 || retrievability > 1) {
    throw new RetentionConfigError(`Retrievability must be a finite number in [0, 1], got ${retrievability}.`);
  }
  let level: RetentionUrgencyLevel;
  if (retrievability >= URGENCY_WARNING_MAX) level = "ok";
  else if (retrievability >= URGENCY_CRITICAL_MAX) level = "warning";
  else level = "critical";
  return { retrievability, level };
}

/** Step 16's due-ness vocabulary -- a query concern derived from `nextReviewAt`, independent of card_state. */
export function getReviewStatus(nextReviewAt: Date | null, now: Date): ReviewStatus {
  if (!nextReviewAt) return "not_started";
  if (now.getTime() < nextReviewAt.getTime()) return "scheduled";
  return isOverdueWindow(nextReviewAt, now) ? "overdue" : "due";
}

// A review becomes "overdue" (materially late, not just past its exact due instant) once more than
// one full MIN_INTERVAL_DAYS has elapsed past nextReviewAt -- distinguishes "due today" from
// "ignored for a while," without inventing a new tunable (reuses the already-locked interval floor).
function isOverdueWindow(nextReviewAt: Date, now: Date): boolean {
  return now.getTime() - nextReviewAt.getTime() > MIN_INTERVAL_DAYS * MS_PER_DAY;
}

export interface RetentionPriorState {
  stability: number;
  difficulty: number;
  cardState: CardState;
  lastReviewedAt: Date;
}

export interface ReviewOutcome {
  stability: number;
  difficulty: number;
  cardState: CardState;
  lapsed: boolean;
  retrievabilityBefore: number | null; // null only for a card's first-ever review
  elapsedDays: number;
  nextReviewAt: Date;
}

/**
 * The full FSRS state machine (§10.1/§10.2), pure. `prior === null` means no retention row exists
 * yet for this (student, concept) -- the "new" card_state, handled as a distinct branch rather than
 * threading the string "new" through, since a real row is never persisted in that state (Step 13).
 *
 *   new        + again -> learning,    S=initialStability(Again), D=initialDifficulty(Again), due now
 *   new        + good  -> review,      S=initialStability(Good),  D=initialDifficulty(Good),  scheduled
 *   learning/  + again -> stays,       S/D unchanged, due now (still consolidating -- not a lapse)
 *   relearning + good  -> review,      S=recall-success formula, D unchanged, scheduled
 *   review     + again -> relearning,  S=lapse formula, D unchanged, due now, lapsed=true
 *   review     + good  -> review,      S=recall-success formula, D unchanged, scheduled
 */
export function applyReview(prior: RetentionPriorState | null, rating: RetentionRating, now: Date): ReviewOutcome {
  validateRating(rating);

  if (!prior) {
    const stability = initialStability(rating);
    const difficulty = initialDifficulty(rating);
    if (rating === "again") {
      return { stability, difficulty, cardState: "learning", lapsed: false, retrievabilityBefore: null, elapsedDays: 0, nextReviewAt: now };
    }
    return { stability, difficulty, cardState: "review", lapsed: false, retrievabilityBefore: null, elapsedDays: 0, nextReviewAt: addDays(now, nextIntervalDays(stability)) };
  }

  validateStability(prior.stability, "prior stability");
  validateDifficulty(prior.difficulty, "prior difficulty");
  const elapsedDays = daysBetween(prior.lastReviewedAt, now);
  const retrievabilityBefore = calculateRetrievability(elapsedDays, prior.stability);

  if (prior.cardState === "learning" || prior.cardState === "relearning") {
    if (rating === "again") {
      return { stability: prior.stability, difficulty: prior.difficulty, cardState: prior.cardState, lapsed: false, retrievabilityBefore, elapsedDays, nextReviewAt: now };
    }
    const stability = nextStabilityOnSuccess(prior.stability, prior.difficulty, retrievabilityBefore);
    return { stability, difficulty: prior.difficulty, cardState: "review", lapsed: false, retrievabilityBefore, elapsedDays, nextReviewAt: addDays(now, nextIntervalDays(stability)) };
  }

  // prior.cardState === "review"
  if (rating === "again") {
    const stability = nextStabilityOnLapse(prior.stability, prior.difficulty, retrievabilityBefore);
    return { stability, difficulty: prior.difficulty, cardState: "relearning", lapsed: true, retrievabilityBefore, elapsedDays, nextReviewAt: now };
  }
  const stability = nextStabilityOnSuccess(prior.stability, prior.difficulty, retrievabilityBefore);
  return { stability, difficulty: prior.difficulty, cardState: "review", lapsed: false, retrievabilityBefore, elapsedDays, nextReviewAt: addDays(now, nextIntervalDays(stability)) };
}

/** Deterministic outcome -> rating mapping (§10.2/Step 10): the client can never submit a rating directly. */
export function ratingFromOutcome(outcome: "correct" | "incorrect"): RetentionRating {
  return outcome === "correct" ? "good" : "again";
}
