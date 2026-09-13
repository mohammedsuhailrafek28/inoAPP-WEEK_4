import assert from "node:assert/strict";
import test from "node:test";
import { IrtConfigError, clampTheta, defaultTheta, difficultyBandToB, probabilityCorrect, sigmoid, updateTheta } from "@/lib/learning/irt";

// The architecture's own hand-verified worked example (ARCHITECTURE.md §9.3), confirmed by
// hand before writing lib/learning/irt.ts (Phase 4, Step 2/10): "a single correct response from
// theta=0 against a difficulty-2 item moves theta partway into (0,2), never to a boundary." The
// task's own illustrative pseudocode (theta_new = theta_old + learningRate*(observed-expected))
// does NOT reproduce this regularized behavior -- implemented the architecture's Newton-step
// formula instead; see irt.ts's header comment for the full discrepancy note.
test("worked example: a single correct response from theta=0 vs a difficulty-2 item lands strictly inside (0, 2)", () => {
  const { theta, expectedProbability } = updateTheta(0, 0, 2, "correct");
  assert.ok(Math.abs(expectedProbability - sigmoid(-2)) < 1e-12);
  assert.ok(theta > 0 && theta < 2, `expected 0 < theta < 2, got ${theta}`);
  assert.ok(Math.abs(theta - 0.797) < 1e-3);
});

test("theta == b -> P(correct) is exactly 0.5", () => {
  assert.equal(probabilityCorrect(0, 0), 0.5);
  assert.equal(probabilityCorrect(1.5, 1.5), 0.5);
});

test("theta > b -> P(correct) > 0.5, theta < b -> P(correct) < 0.5", () => {
  assert.ok(probabilityCorrect(1, 0) > 0.5);
  assert.ok(probabilityCorrect(0, 1) < 0.5);
});

test("monotonicity in theta: P(correct) strictly increases as theta increases, for fixed b", () => {
  const thetas = [-3, -1, 0, 0.5, 1, 3];
  let previous = -Infinity;
  for (const theta of thetas) {
    const p = probabilityCorrect(theta, 0);
    assert.ok(p > previous, `expected increasing at theta=${theta}`);
    previous = p;
  }
});

test("monotonicity in b: P(correct) strictly decreases as b increases, for fixed theta", () => {
  const bs = [-3, -1, 0, 0.5, 1, 3];
  let previous = Infinity;
  for (const b of bs) {
    const p = probabilityCorrect(0, b);
    assert.ok(p < previous, `expected decreasing at b=${b}`);
    previous = p;
  }
});

test("a correct outcome always increases theta, regardless of prior theta or b", () => {
  for (const theta of [-3, -1, 0, 1, 3]) {
    for (const b of [-2, 0, 2]) {
      const { theta: newTheta } = updateTheta(theta, 5, b, "correct");
      assert.ok(newTheta > theta, `theta=${theta} b=${b}: expected increase, got ${newTheta}`);
    }
  }
});

test("an incorrect outcome always decreases theta, regardless of prior theta or b", () => {
  for (const theta of [-3, -1, 0, 1, 3]) {
    for (const b of [-2, 0, 2]) {
      const { theta: newTheta } = updateTheta(theta, 5, b, "incorrect");
      assert.ok(newTheta < theta, `theta=${theta} b=${b}: expected decrease, got ${newTheta}`);
    }
  }
});

test("a correct answer on a HARD item moves theta more than a correct answer on an EASY item", () => {
  const theta = 0;
  const hardMove = updateTheta(theta, 0, 1.0, "correct").theta - theta; // hard: b=1, surprising to get right
  const easyMove = updateTheta(theta, 0, -1.0, "correct").theta - theta; // easy: b=-1, expected to get right
  assert.ok(hardMove > easyMove, `expected hard-correct move (${hardMove}) > easy-correct move (${easyMove})`);
});

test("an incorrect answer on an EASY item moves theta down more than an incorrect answer on a HARD item", () => {
  const theta = 0;
  const easyDrop = theta - updateTheta(theta, 0, -1.0, "incorrect").theta; // easy: surprising to get wrong
  const hardDrop = theta - updateTheta(theta, 0, 1.0, "incorrect").theta; // hard: expected to get wrong
  assert.ok(easyDrop > hardDrop, `expected easy-incorrect drop (${easyDrop}) > hard-incorrect drop (${hardDrop})`);
});

test("more accumulated observations regularize (dampen) the same response's effect on theta", () => {
  const fresh = Math.abs(updateTheta(0, 0, 1, "correct").theta - 0);
  const seasoned = Math.abs(updateTheta(0, 20, 1, "correct").theta - 0);
  assert.ok(seasoned < fresh, `expected a smaller move with more prior observations: fresh=${fresh} seasoned=${seasoned}`);
});

test("never exceeds the upper theta bound, and approaches it asymptotically (regularization, not saturation) under a long repeated-correct sequence", () => {
  // The growing priorPrecision term is what makes this asymptotic rather than a hard slam into
  // the clamp: each successive step shrinks, so theta climbs toward 4 without ever reaching it in
  // finitely many steps -- exactly the "perpetually responsive" property the regularization exists
  // for. clampTheta() itself (tested directly below) is the actual hard boundary guarantee.
  let theta = 3.9;
  let observationCount = 0;
  const trace = [theta];
  for (let i = 0; i < 20; i++) {
    theta = updateTheta(theta, observationCount, -4, "correct").theta;
    observationCount += 1;
    trace.push(theta);
    assert.ok(theta <= 4, `theta exceeded the upper bound: ${theta}`);
  }
  for (let i = 1; i < trace.length; i++) assert.ok(trace[i] >= trace[i - 1], `expected non-decreasing at step ${i}: ${trace}`);
  assert.ok(theta > 3.9, "expected measurable further progress toward the bound");
});

test("never exceeds the lower theta bound under a long repeated-incorrect sequence", () => {
  let theta = -3.9;
  let observationCount = 0;
  const trace = [theta];
  for (let i = 0; i < 20; i++) {
    theta = updateTheta(theta, observationCount, 4, "incorrect").theta;
    observationCount += 1;
    trace.push(theta);
    assert.ok(theta >= -4, `theta exceeded the lower bound: ${theta}`);
  }
  for (let i = 1; i < trace.length; i++) assert.ok(trace[i] <= trace[i - 1], `expected non-increasing at step ${i}: ${trace}`);
  assert.ok(theta < -3.9, "expected measurable further progress toward the bound");
});

test("clampTheta() is the actual hard boundary guarantee", () => {
  assert.equal(clampTheta(100), 4);
  assert.equal(clampTheta(-100), -4);
  assert.equal(clampTheta(0), 0);
});

test("rejects an out-of-bounds or non-finite theta", () => {
  assert.throws(() => probabilityCorrect(5, 0), IrtConfigError);
  assert.throws(() => probabilityCorrect(-5, 0), IrtConfigError);
  assert.throws(() => probabilityCorrect(NaN, 0), IrtConfigError);
  assert.throws(() => probabilityCorrect(Infinity, 0), IrtConfigError);
});

test("rejects a non-finite item difficulty b", () => {
  assert.throws(() => probabilityCorrect(0, NaN), IrtConfigError);
  assert.throws(() => probabilityCorrect(0, Infinity), IrtConfigError);
});

test("rejects an invalid observation count", () => {
  assert.throws(() => updateTheta(0, -1, 0, "correct"), IrtConfigError);
  assert.throws(() => updateTheta(0, 1.5, 0, "correct"), IrtConfigError);
});

test("no NaN/Infinity across a representative grid of valid inputs", () => {
  const thetas = [-4, -2, 0, 2, 4];
  const bs = [-4, -1, 0, 1, 4];
  const counts = [0, 1, 5, 20, 100];
  for (const theta of thetas) {
    for (const b of bs) {
      for (const count of counts) {
        for (const outcome of ["correct", "incorrect"] as const) {
          const { theta: newTheta, expectedProbability } = updateTheta(theta, count, b, outcome);
          assert.ok(Number.isFinite(newTheta), `theta not finite for theta=${theta} b=${b} count=${count}`);
          assert.ok(Number.isFinite(expectedProbability), `expectedProbability not finite for theta=${theta} b=${b}`);
        }
      }
    }
  }
});

test("deterministic: identical input always produces identical output", () => {
  const a = updateTheta(0.37, 4, 0.5, "correct");
  const b = updateTheta(0.37, 4, 0.5, "correct");
  assert.deepEqual(a, b);
});

test("difficultyBandToB implements the fixed, auditable label -> b mapping (§9.2)", () => {
  assert.equal(difficultyBandToB("easy"), -1.0);
  assert.equal(difficultyBandToB("medium"), 0.0);
  assert.equal(difficultyBandToB("hard"), 1.0);
});

test("defaultTheta is the standard Rasch-model prior, 0", () => {
  assert.equal(defaultTheta(), 0);
});
