// Bayesian Knowledge Tracing -- pure, deterministic, no I/O (ARCHITECTURE.md §7).
//
// Formula, confirmed against the locked architecture before writing any code (Phase 3, Step 4):
// the task's own illustrative pseudocode uses `newMastery = posterior + (1-posterior)*P(T)`, which
// implicitly assumes P(Forget) = 0. The locked architecture (§7.2) instead uses
// `newMastery = posterior*(1 - pForget) + (1-posterior)*pLearn` with a small non-zero
// `pForget = BKT_FORGET_WITHIN_SESSION = 0.02`. The architecture's own hand-verified worked example
// (P_L=0.5, P_T=0.3, P_Forget=0.05, P_S=0.1, P_G=0.2 -> correct gives exactly 0.8318) only
// reproduces with the pForget term included -- confirmed by hand below and in bkt.test.ts. This
// file implements the architecture's formula, not the task's simplified illustration; see the
// Phase 3 report for this discrepancy and why it was resolved this way.
//
// Gemini has zero authority here: nothing in this file ever reads a value the LLM produced, and
// nothing outside lib/learning/mastery.ts's persistence path may write learner_concept_state.

import { LEARNING_CONFIG } from "@/lib/learning/constants";
import type { BktItemType, BktOutcome, BktParams, BktUpdateResult } from "@/types/learning";

export class BktConfigError extends Error {}

const DENOMINATOR_FLOOR = LEARNING_CONFIG.SAFETY_CLAMPS.BKT_BAYES_DENOMINATOR_FLOOR.value;
const MIN_PROBABILITY = LEARNING_CONFIG.SAFETY_CLAMPS.BKT_MIN_PROBABILITY.value;
const MAX_PROBABILITY = LEARNING_CONFIG.SAFETY_CLAMPS.BKT_MAX_PROBABILITY.value;
const MASTERY_ACHIEVED_THRESHOLD = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.MASTERY_ACHIEVED_THRESHOLD.value;

function isUnitProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Fails closed (Step 5): an internally-inconsistent BKT configuration must never silently produce
 * NaN/Infinity or a corrupted mastery value -- it throws before any arithmetic runs.
 */
export function validateBktParams(params: BktParams): void {
  if (!isUnitProbability(params.pLearn)) throw new BktConfigError(`P(T) must be a finite number in [0,1], got ${params.pLearn}.`);
  if (!isUnitProbability(params.pSlip)) throw new BktConfigError(`P(S) must be a finite number in [0,1], got ${params.pSlip}.`);
  if (!isUnitProbability(params.pGuess)) throw new BktConfigError(`P(G) must be a finite number in [0,1], got ${params.pGuess}.`);
  if (!isUnitProbability(params.pForget)) throw new BktConfigError(`P(Forget) must be a finite number in [0,1], got ${params.pForget}.`);
}

function validatePriorMastery(pMastery: number): void {
  if (!isUnitProbability(pMastery)) throw new BktConfigError(`Prior mastery must be a finite number in [0,1], got ${pMastery}.`);
}

/** Bayesian update given a CORRECT observation (§7.2). */
export function posteriorAfterCorrect(pMastery: number, params: BktParams): number {
  validatePriorMastery(pMastery);
  validateBktParams(params);
  const pCorrectGivenMastery = 1 - params.pSlip;
  const pCorrectGivenNotMastery = params.pGuess;
  const pCorrect = Math.max(pCorrectGivenMastery * pMastery + pCorrectGivenNotMastery * (1 - pMastery), DENOMINATOR_FLOOR);
  return (pCorrectGivenMastery * pMastery) / pCorrect;
}

/** Bayesian update given an INCORRECT observation (§7.2). */
export function posteriorAfterIncorrect(pMastery: number, params: BktParams): number {
  validatePriorMastery(pMastery);
  validateBktParams(params);
  const pIncorrectGivenMastery = params.pSlip;
  const pIncorrectGivenNotMastery = 1 - params.pGuess;
  const pIncorrect = Math.max(pIncorrectGivenMastery * pMastery + pIncorrectGivenNotMastery * (1 - pMastery), DENOMINATOR_FLOOR);
  return (pIncorrectGivenMastery * pMastery) / pIncorrect;
}

/**
 * A partial (short-answer rubric) outcome (§7.6): a weighted blend of the correct/incorrect
 * posterior branches, `r` in [0,1]. Not part of Step 4's required function list, but implements
 * §7.6's explicit rule; unused until a later phase's short-answer evaluator supplies a real `r`.
 */
export function posteriorAfterPartial(pMastery: number, params: BktParams, r: number): number {
  if (!isUnitProbability(r)) throw new BktConfigError(`Partial-credit score r must be a finite number in [0,1], got ${r}.`);
  const correct = posteriorAfterCorrect(pMastery, params);
  const incorrect = posteriorAfterIncorrect(pMastery, params);
  return r * correct + (1 - r) * incorrect;
}

/** The learning-transition step (§7.2), applied after either Bayesian update, then clamped (§6A). */
export function applyLearningTransition(posterior: number, params: BktParams): number {
  if (!isUnitProbability(posterior)) throw new BktConfigError(`Posterior must be a finite number in [0,1], got ${posterior}.`);
  validateBktParams(params);
  const newMastery = posterior * (1 - params.pForget) + (1 - posterior) * params.pLearn;
  return clampMastery(newMastery);
}

/** The stronger-than-source absorbing-state guard (§7.2/§6A): keeps mastery perpetually responsive to new evidence. */
export function clampMastery(mastery: number): number {
  if (typeof mastery !== "number" || !Number.isFinite(mastery)) throw new BktConfigError(`Computed mastery must be a finite number, got ${mastery}.`);
  return Math.min(MAX_PROBABILITY, Math.max(MIN_PROBABILITY, mastery));
}

/**
 * The single entry point (Step 4's `updateBkt`): prior mastery + params + an observed outcome ->
 * { posterior, mastery }. `posterior` is exposed (not just the final `mastery`) because
 * lib/learning/mastery.ts's transition ledger records it for audit/replay.
 */
export function updateBkt(pMastery: number, params: BktParams, outcome: BktOutcome): BktUpdateResult {
  const posterior = outcome === "correct" ? posteriorAfterCorrect(pMastery, params) : posteriorAfterIncorrect(pMastery, params);
  const mastery = applyLearningTransition(posterior, params);
  return { posterior, mastery };
}

/** The "hard" BKT mastery verdict (§7.3) -- a plain threshold check; evidence-sufficiency gating is a separate, higher-level concern (see lib/learning/mastery.ts). */
export function isMastered(pMastery: number, threshold: number = MASTERY_ACHIEVED_THRESHOLD): boolean {
  validatePriorMastery(pMastery);
  return pMastery >= threshold;
}

/** Resolves the global default BKT parameters for a given item type (§7.4) -- concept-level P(L0)/P(T) overrides are applied by the caller (lib/learning/mastery.ts), not here. */
export function defaultBktParams(itemType: BktItemType = "mcq"): BktParams {
  const model = LEARNING_CONFIG.MODEL_PARAMETERS;
  return {
    pLearn: model.BKT_DEFAULT_P_T.value,
    pSlip: itemType === "mcq" ? model.BKT_DEFAULT_P_S_MCQ.value : model.BKT_DEFAULT_P_S_SHORT_ANSWER.value,
    pGuess: itemType === "mcq" ? model.BKT_DEFAULT_P_G_MCQ.value : model.BKT_DEFAULT_P_G_SHORT_ANSWER.value,
    pForget: model.BKT_FORGET_WITHIN_SESSION.value,
  };
}
