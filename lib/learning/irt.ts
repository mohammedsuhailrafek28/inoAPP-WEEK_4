// Item Response Theory -- pure, deterministic, no I/O (ARCHITECTURE.md §9).
//
// Model: 1PL/Rasch. No discrimination parameter `a`, no guessing parameter -- exactly as locked
// (§9's own "IRT model re-review": nothing in this design ever consumes a discrimination
// parameter, so one is never introduced). P(correct | theta, b) = sigmoid(theta - b).
//
// Update rule, confirmed against the locked architecture before writing any code (Phase 4, Step 2/
// Step 10): the task's own illustrative pseudocode suggests a plain fixed-learning-rate gradient
// step (`theta_new = theta_old + learningRate*(observed-expected)`). The locked architecture (§9.3)
// instead uses a regularized, precision-weighted Newton step, simplified from the audited source's
// up-to-8-iteration batch fit to ONE Newton step per incoming response:
//   priorPrecision = IRT_BASE_PRIOR_PRECISION + IRT_INFO_PER_OBSERVATION * observationCount
//   predicted = sigmoid(theta - b)
//   dL  = -priorPrecision*(theta - priorTheta) + (outcome - predicted)   // theta === priorTheta
//                                                                        // for a single step, so
//                                                                        // this term is always 0
//   d2L = -priorPrecision - predicted*(1-predicted)
//   step = clamp(dL/d2L, -1, 1)
//   theta' = clamp(theta - step, -4, 4)
// This is what actually reproduces the architecture's own worked example ("a single correct
// response from theta=0 against a difficulty-2 item moves theta partway into (0,2), never to a
// boundary") -- verified by hand below and in irt.test.ts. The `priorPrecision` term growing with
// `observationCount` is exactly what prevents one binary response from saturating theta.
//
// Gemini has zero authority here, exactly like BKT: nothing in this file ever reads an LLM-produced
// value, and nothing outside lib/learning/ability.ts's persistence path may write learner_ability.

import { LEARNING_CONFIG } from "@/lib/learning/constants";
import type { DifficultyBand, IrtOutcome } from "@/types/learning";

export class IrtConfigError extends Error {}

const THETA_BOUNDS = LEARNING_CONFIG.MODEL_PARAMETERS.IRT_THETA_BOUNDS.value;
const BASE_PRIOR_PRECISION = LEARNING_CONFIG.MODEL_PARAMETERS.IRT_BASE_PRIOR_PRECISION.value;
const INFO_PER_OBSERVATION = LEARNING_CONFIG.MODEL_PARAMETERS.IRT_INFO_PER_OBSERVATION.value;
const STEP_CLAMP = LEARNING_CONFIG.SAFETY_CLAMPS.IRT_NEWTON_STEP_CLAMP.value;
const ITEM_DIFFICULTY_B = LEARNING_CONFIG.MODEL_PARAMETERS.IRT_ITEM_DIFFICULTY_B.value;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Fails closed (mirrors bkt.ts's validateBktParams): an inconsistent IRT input must never silently produce NaN/Infinity. */
function validateTheta(theta: number, label = "theta"): void {
  if (!isFiniteNumber(theta) || theta < THETA_BOUNDS.min || theta > THETA_BOUNDS.max) {
    throw new IrtConfigError(`${label} must be a finite number in [${THETA_BOUNDS.min}, ${THETA_BOUNDS.max}], got ${theta}.`);
  }
}

function validateDifficultyB(b: number): void {
  if (!isFiniteNumber(b)) throw new IrtConfigError(`Item difficulty b must be a finite number, got ${b}.`);
}

function validateObservationCount(count: number): void {
  if (!Number.isInteger(count) || count < 0) throw new IrtConfigError(`Observation count must be a non-negative integer, got ${count}.`);
}

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export function clampTheta(theta: number): number {
  if (!isFiniteNumber(theta)) throw new IrtConfigError(`Computed theta must be a finite number, got ${theta}.`);
  return Math.min(THETA_BOUNDS.max, Math.max(THETA_BOUNDS.min, theta));
}

/** P(correct | theta, b) = sigmoid(theta - b) -- the entire 1PL/Rasch probability model. */
export function probabilityCorrect(theta: number, b: number): number {
  validateTheta(theta);
  validateDifficultyB(b);
  return sigmoid(theta - b);
}

/** The fixed, auditable product-difficulty-label -> b mapping (§9.2). Never FSRS-derived. */
export function difficultyBandToB(band: DifficultyBand): number {
  return ITEM_DIFFICULTY_B[band];
}

export interface IrtUpdateResult {
  theta: number;
  expectedProbability: number; // predicted P(correct) before the observation -- recorded on the audit ledger
}

/**
 * The single entry point: prior theta + observationCount + item difficulty b + an observed outcome
 * -> { theta, expectedProbability }. One regularized Newton step (§9.3), not an inner iteration
 * loop -- priorTheta === theta for this single-step usage, so the prior-pull term in dL is always
 * exactly 0 (documented above, verified in irt.test.ts).
 */
export function updateTheta(theta: number, observationCount: number, b: number, outcome: IrtOutcome): IrtUpdateResult {
  validateTheta(theta);
  validateDifficultyB(b);
  validateObservationCount(observationCount);

  const priorPrecision = BASE_PRIOR_PRECISION + INFO_PER_OBSERVATION * observationCount;
  const predicted = sigmoid(theta - b);
  const observed = outcome === "correct" ? 1 : 0;
  const dL = observed - predicted; // -priorPrecision*(theta-priorTheta) omitted: always 0 for a single step
  const d2L = -priorPrecision - predicted * (1 - predicted); // always < 0 -- no floor needed, unlike BKT's Bayesian denominator
  const rawStep = dL / d2L;
  const step = Math.min(STEP_CLAMP.max, Math.max(STEP_CLAMP.min, rawStep));
  const newTheta = clampTheta(theta - step);
  return { theta: newTheta, expectedProbability: predicted };
}

/** Ability starts at theta=0 with zero observations -- the standard Rasch-model prior. */
export function defaultTheta(): number {
  return 0;
}
