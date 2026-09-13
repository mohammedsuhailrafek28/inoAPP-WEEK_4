import assert from "node:assert/strict";
import test from "node:test";
import {
  BktConfigError,
  applyLearningTransition,
  clampMastery,
  defaultBktParams,
  isMastered,
  posteriorAfterCorrect,
  posteriorAfterIncorrect,
  posteriorAfterPartial,
  updateBkt,
} from "@/lib/learning/bkt";
import type { BktParams } from "@/types/learning";

// The architecture's own hand-verified worked example (ARCHITECTURE.md §7) -- confirmed by
// hand before writing lib/learning/bkt.ts (Phase 3, Step 4): P_L=0.5, P_T=0.3, P_Forget=0.05,
// P_S=0.1, P_G=0.2 -> correct gives exactly 0.8318, incorrect gives exactly 0.3722. This ONLY
// reproduces with the pForget term in the learning-transition formula included -- the task's own
// simplified pseudocode (newMastery = posterior + (1-posterior)*P(T), implicitly pForget=0) does
// NOT reproduce these numbers, which is why bkt.ts implements the architecture's formula instead.
const REFERENCE_PARAMS: BktParams = { pLearn: 0.3, pSlip: 0.1, pGuess: 0.2, pForget: 0.05 };

test("1. correct answer update matches the architecture's hand-verified reference case exactly", () => {
  const { posterior, mastery } = updateBkt(0.5, REFERENCE_PARAMS, "correct");
  assert.ok(Math.abs(posterior - 0.818181818) < 1e-6);
  assert.ok(Math.abs(mastery - 0.8318) < 1e-4);
});

test("2. incorrect answer update matches the architecture's hand-verified reference case exactly", () => {
  const { posterior, mastery } = updateBkt(0.5, REFERENCE_PARAMS, "incorrect");
  assert.ok(Math.abs(posterior - 0.111111111) < 1e-6);
  assert.ok(Math.abs(mastery - 0.3722) < 1e-4);
});

test("3. repeated correct answers trend upward from a low starting mastery", () => {
  const params = defaultBktParams("mcq");
  let mastery = 0.2;
  const trace = [mastery];
  for (let i = 0; i < 5; i++) {
    mastery = updateBkt(mastery, params, "correct").mastery;
    trace.push(mastery);
  }
  for (let i = 1; i < trace.length; i++) assert.ok(trace[i] > trace[i - 1], `expected strictly increasing at step ${i}: ${trace}`);
});

test("4. repeated incorrect answers trend downward from a high starting mastery", () => {
  const params = defaultBktParams("mcq");
  let mastery = 0.9;
  const trace = [mastery];
  for (let i = 0; i < 5; i++) {
    mastery = updateBkt(mastery, params, "incorrect").mastery;
    trace.push(mastery);
  }
  for (let i = 1; i < trace.length; i++) assert.ok(trace[i] < trace[i - 1], `expected strictly decreasing at step ${i}: ${trace}`);
});

test("5. the learning transition is a distinct step applied after the Bayesian observation", () => {
  const posterior = posteriorAfterCorrect(0.5, REFERENCE_PARAMS);
  const mastery = applyLearningTransition(posterior, REFERENCE_PARAMS);
  assert.notEqual(posterior, mastery); // pLearn/pForget must actually move the value
  assert.ok(Math.abs(mastery - 0.8318) < 1e-4);
});

test("6. lower clamp: mastery never reported below 0.02", () => {
  // A very low prior, high slip, low guess, near-total incorrect-branch weighting drives the raw
  // posterior/transition arbitrarily close to 0 -- clampMastery must still floor it at 0.02.
  const harsh: BktParams = { pLearn: 0.0, pSlip: 0.01, pGuess: 0.01, pForget: 0.5 };
  const { mastery } = updateBkt(0.02, harsh, "incorrect");
  assert.equal(mastery, 0.02);
  assert.equal(clampMastery(-5), 0.02);
});

test("7. upper clamp: mastery never reported above 0.98", () => {
  const generous: BktParams = { pLearn: 1.0, pSlip: 0.0, pGuess: 0.0, pForget: 0.0 };
  const { mastery } = updateBkt(0.98, generous, "correct");
  assert.equal(mastery, 0.98);
  assert.equal(clampMastery(5), 0.98);
});

test("8. invalid P(G) fails closed", () => {
  assert.throws(() => updateBkt(0.5, { ...REFERENCE_PARAMS, pGuess: 1.5 }, "correct"), BktConfigError);
  assert.throws(() => updateBkt(0.5, { ...REFERENCE_PARAMS, pGuess: -0.1 }, "correct"), BktConfigError);
  assert.throws(() => updateBkt(0.5, { ...REFERENCE_PARAMS, pGuess: NaN }, "correct"), BktConfigError);
});

test("9. invalid P(S) fails closed", () => {
  assert.throws(() => updateBkt(0.5, { ...REFERENCE_PARAMS, pSlip: 1.1 }, "correct"), BktConfigError);
  assert.throws(() => updateBkt(0.5, { ...REFERENCE_PARAMS, pSlip: -0.01 }, "incorrect"), BktConfigError);
});

test("10. invalid P(T) fails closed", () => {
  assert.throws(() => applyLearningTransition(0.5, { ...REFERENCE_PARAMS, pLearn: Infinity }), BktConfigError);
  assert.throws(() => applyLearningTransition(0.5, { ...REFERENCE_PARAMS, pLearn: -0.5 }), BktConfigError);
});

test("11. invalid initial/prior mastery fails closed", () => {
  assert.throws(() => posteriorAfterCorrect(1.5, REFERENCE_PARAMS), BktConfigError);
  assert.throws(() => posteriorAfterCorrect(-0.1, REFERENCE_PARAMS), BktConfigError);
  assert.throws(() => posteriorAfterCorrect(NaN, REFERENCE_PARAMS), BktConfigError);
});

test("12. no NaN/Infinity across a representative grid of valid inputs", () => {
  const priors = [0.02, 0.1, 0.3, 0.5, 0.7, 0.9, 0.98];
  const paramSets = [defaultBktParams("mcq"), defaultBktParams("short_answer"), REFERENCE_PARAMS, { pLearn: 0, pSlip: 0, pGuess: 0, pForget: 0 }];
  for (const prior of priors) {
    for (const params of paramSets) {
      for (const outcome of ["correct", "incorrect"] as const) {
        const { posterior, mastery } = updateBkt(prior, params, outcome);
        assert.ok(Number.isFinite(posterior), `posterior not finite for prior=${prior} outcome=${outcome}`);
        assert.ok(Number.isFinite(mastery), `mastery not finite for prior=${prior} outcome=${outcome}`);
      }
    }
  }
});

test("13. deterministic: identical input always produces identical output", () => {
  const a = updateBkt(0.4237, REFERENCE_PARAMS, "correct");
  const b = updateBkt(0.4237, REFERENCE_PARAMS, "correct");
  assert.deepEqual(a, b);
});

// --- Partial-credit blend (§7.6) -----------------------------------------------------------

test("posteriorAfterPartial blends the correct/incorrect branches by r, and rejects r outside [0,1]", () => {
  const full = posteriorAfterPartial(0.5, REFERENCE_PARAMS, 1);
  const none = posteriorAfterPartial(0.5, REFERENCE_PARAMS, 0);
  assert.ok(Math.abs(full - posteriorAfterCorrect(0.5, REFERENCE_PARAMS)) < 1e-12);
  assert.ok(Math.abs(none - posteriorAfterIncorrect(0.5, REFERENCE_PARAMS)) < 1e-12);
  const half = posteriorAfterPartial(0.5, REFERENCE_PARAMS, 0.5);
  assert.ok(half > none && half < full);
  assert.throws(() => posteriorAfterPartial(0.5, REFERENCE_PARAMS, 1.2), BktConfigError);
});

// --- isMastered ------------------------------------------------------------------------------

test("isMastered is a plain threshold check against MASTERY_ACHIEVED_THRESHOLD (0.85) by default", () => {
  assert.equal(isMastered(0.84), false);
  assert.equal(isMastered(0.85), true);
  assert.equal(isMastered(0.86), true);
  assert.equal(isMastered(0.5, 0.4), true); // explicit override threshold
});

// --- Property / invariant tests (Step 25) --------------------------------------------------

test("invariant: mastery is always within [0.02, 0.98] across a wide grid of valid parameters", () => {
  const priors = [0, 0.02, 0.2, 0.5, 0.8, 0.98, 1];
  const rates = [0, 0.1, 0.3, 0.5, 0.9, 1];
  for (const prior of priors) {
    for (const pLearn of rates) {
      for (const pSlip of rates) {
        for (const pGuess of rates) {
          for (const pForget of rates) {
            for (const outcome of ["correct", "incorrect"] as const) {
              const { mastery } = updateBkt(prior, { pLearn, pSlip, pGuess, pForget }, outcome);
              assert.ok(mastery >= 0.02 && mastery <= 0.98, `out of bounds: ${mastery}`);
            }
          }
        }
      }
    }
  }
});

test("invariant: with an informative item (P(S)+P(G) < 1), correct evidence raises the posterior and incorrect evidence lowers it, relative to the prior", () => {
  // This is the precise condition under which BKT's Bayesian step is guaranteed monotonic in the
  // expected direction -- an item where P(correct | mastered) > P(correct | not mastered). Both of
  // this project's configured default parameter sets (§7.4) satisfy it; a pathological item that
  // doesn't (e.g. P(S)=0.9, P(G)=0.9) is explicitly NOT claimed to behave this way.
  for (const params of [defaultBktParams("mcq"), defaultBktParams("short_answer")]) {
    assert.ok(params.pSlip + params.pGuess < 1, "configured defaults must be informative items");
    for (const prior of [0.05, 0.2, 0.5, 0.8, 0.95]) {
      assert.ok(posteriorAfterCorrect(prior, params) > prior, `correct should raise posterior above prior=${prior}`);
      assert.ok(posteriorAfterIncorrect(prior, params) < prior, `incorrect should lower posterior below prior=${prior}`);
    }
  }
});

test("invariant: a non-informative item (P(S)+P(G) >= 1) can invert the usual direction -- documented exception, not a bug", () => {
  const nonInformative: BktParams = { pLearn: 0.3, pSlip: 0.9, pGuess: 0.9, pForget: 0.02 };
  assert.ok(nonInformative.pSlip + nonInformative.pGuess >= 1);
  // A correct answer is now WEAK evidence of mastery (a high-slip, high-guess item) -- the
  // posterior can legitimately fall rather than rise. This is mathematically expected, not a
  // defect in updateBkt().
  const posterior = posteriorAfterCorrect(0.5, nonInformative);
  assert.ok(posterior <= 0.5);
});
