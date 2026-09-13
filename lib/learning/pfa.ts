// Performance Factors Analysis -- pure, deterministic, no I/O (ARCHITECTURE.md §8).
//
// PFA is explicitly NOT a second mastery score. It answers a different question than BKT:
//   BKT: "how likely is this concept mastered?"          -- authoritative, persisted, §7
//   PFA: "what does practice history say about a plateau?" -- a read-only diagnostic signal, never
//        persisted, never written back into learner_concept_state, and consumed by nothing in
//        Phase 3 (its locked consumers -- the pedagogical engine's difficulty modifier and the
//        PLATEAU alert -- are Phase 8/Phase 11 work). It is built now, standalone and tested, so
//        those later phases have a ready, correct signal to call.
//
// No new storage: PFA's "opportunities/successes/failures" ARE learner_concept_state's own
// evidence_count/correct_count/incorrect_count -- the same counters BKT already maintains.

import { LEARNING_CONFIG } from "@/lib/learning/constants";
import type { BktOutcome, PracticeSignal } from "@/types/learning";

const BETA_SUCCESS = LEARNING_CONFIG.MODEL_PARAMETERS.PFA_BETA_SUCCESS.value;
const BETA_FAILURE = LEARNING_CONFIG.MODEL_PARAMETERS.PFA_BETA_FAILURE.value;
export const PFA_PLATEAU_WINDOW = 4; // ARCHITECTURE.md §8 -- fixed at 4 by the audited source, not product-tunable
export const PFA_PLATEAU_DELTA = 0.025; // ARCHITECTURE.md §8 -- ditto

/** Raw, symmetric, no-intercept PFA score -- ported verbatim (§8). Not itself a probability. */
export function pfaScore(successes: number, failures: number): number {
  return BETA_SUCCESS * successes + BETA_FAILURE * failures;
}

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** The saturating practice-performance probability -- only this, not the raw score, can plateau. */
export function pfaProbability(successes: number, failures: number): number {
  return sigmoid(pfaScore(successes, failures));
}

/**
 * §8's exact plateau test: replay the cumulative pfaProbability across the last `window`
 * chronological outcomes on a concept, then check whether the largest adjacent change is below
 * PFA_PLATEAU_DELTA. `priorSuccesses`/`priorFailures` are the cumulative counts immediately BEFORE
 * the first of `recentOutcomes` (so each of the `window` points reflects the true running total at
 * that moment in history, not just the local counts within the window).
 */
export function isPlateaued(recentOutcomes: BktOutcome[], priorSuccesses: number, priorFailures: number, window: number = PFA_PLATEAU_WINDOW): boolean {
  if (recentOutcomes.length < window) return false;
  const relevant = recentOutcomes.slice(-window);
  let successes = priorSuccesses;
  let failures = priorFailures;
  const probabilities: number[] = [];
  for (const outcome of relevant) {
    if (outcome === "correct") successes += 1;
    else failures += 1;
    probabilities.push(pfaProbability(successes, failures));
  }
  let maxAdjacentDelta = 0;
  for (let i = 1; i < probabilities.length; i++) {
    maxAdjacentDelta = Math.max(maxAdjacentDelta, Math.abs(probabilities[i] - probabilities[i - 1]));
  }
  return maxAdjacentDelta < PFA_PLATEAU_DELTA;
}

/**
 * Assembles the full practice signal for one concept. `recentOutcomes` should be the most recent
 * scored outcomes in chronological order (oldest first); `totalSuccesses`/`totalFailures` are the
 * current, full cumulative counts from learner_concept_state (used for successRate/pfaProbability,
 * which reflect ALL evidence, not just the plateau-detection window).
 */
export function computePracticeSignal(totalSuccesses: number, totalFailures: number, recentOutcomes: BktOutcome[]): PracticeSignal {
  const opportunities = totalSuccesses + totalFailures;
  if (opportunities === 0) {
    return { opportunities: 0, successRate: null, pfaProbability: null, plateaued: false };
  }
  const recentSuccesses = recentOutcomes.slice(-PFA_PLATEAU_WINDOW).filter((o) => o === "correct").length;
  const recentFailures = Math.min(recentOutcomes.length, PFA_PLATEAU_WINDOW) - recentSuccesses;
  const priorSuccesses = totalSuccesses - recentSuccesses;
  const priorFailures = totalFailures - recentFailures;
  return {
    opportunities,
    successRate: totalSuccesses / opportunities,
    pfaProbability: pfaProbability(totalSuccesses, totalFailures),
    plateaued: isPlateaued(recentOutcomes, priorSuccesses, priorFailures),
  };
}
