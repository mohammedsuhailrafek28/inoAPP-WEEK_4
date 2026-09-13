import assert from "node:assert/strict";
import test from "node:test";
import { computePracticeSignal, isPlateaued, pfaProbability, pfaScore, sigmoid, PFA_PLATEAU_DELTA, PFA_PLATEAU_WINDOW } from "@/lib/learning/pfa";
import type { BktOutcome } from "@/types/learning";

test("pfaScore is symmetric with no intercept: zero successes and failures scores exactly 0", () => {
  assert.equal(pfaScore(0, 0), 0);
  assert.ok(Math.abs(pfaScore(3, 0) - 0.33) < 1e-9);
  assert.ok(Math.abs(pfaScore(0, 3) - -0.33) < 1e-9);
  assert.ok(Math.abs(pfaScore(3, 3)) < 1e-9); // equal successes/failures cancel exactly
});

test("pfaProbability(0,0) is exactly 0.5 -- sigmoid(0)", () => {
  assert.equal(pfaProbability(0, 0), 0.5);
});

test("computePracticeSignal: zero opportunities returns nulls, never a fabricated 0", () => {
  const signal = computePracticeSignal(0, 0, []);
  assert.equal(signal.opportunities, 0);
  assert.equal(signal.successRate, null);
  assert.equal(signal.pfaProbability, null);
  assert.equal(signal.plateaued, false);
});

test("computePracticeSignal: all correct", () => {
  const signal = computePracticeSignal(5, 0, ["correct", "correct", "correct", "correct", "correct"]);
  assert.equal(signal.opportunities, 5);
  assert.equal(signal.successRate, 1);
  assert.ok(signal.pfaProbability! > 0.5);
});

test("computePracticeSignal: all incorrect", () => {
  const signal = computePracticeSignal(0, 5, ["incorrect", "incorrect", "incorrect", "incorrect", "incorrect"]);
  assert.equal(signal.opportunities, 5);
  assert.equal(signal.successRate, 0);
  assert.ok(signal.pfaProbability! < 0.5);
});

test("computePracticeSignal: mixed evidence produces an intermediate signal", () => {
  const signal = computePracticeSignal(3, 2, ["correct", "incorrect", "correct", "incorrect", "correct"]);
  assert.equal(signal.opportunities, 5);
  assert.equal(signal.successRate, 0.6);
  assert.ok(signal.pfaProbability! > 0 && signal.pfaProbability! < 1);
});

test("isPlateaued is false with fewer than the plateau window's worth of outcomes", () => {
  assert.equal(isPlateaued(["correct", "correct"], 0, 0), false);
});

test("plateau condition: once the cumulative score is deep in saturation, one more success/failure barely moves the probability", () => {
  // A large NET IMBALANCE (not merely a large prior count) is what saturates the sigmoid -- 50
  // successes against 0 failures sits far out on the curve, where its slope is nearly flat.
  // (50 successes, 50 failures would instead sit at score=0, the sigmoid's STEEPEST point --
  // that would NOT plateau, which is a distinct, deliberately-tested case below.)
  const recent: BktOutcome[] = ["correct", "incorrect", "correct", "incorrect"];
  assert.equal(isPlateaued(recent, 50, 0), true);
});

test("an even prior split (score exactly 0, the sigmoid's steepest point) does NOT plateau despite a large prior count", () => {
  const recent: BktOutcome[] = ["correct", "incorrect", "correct", "incorrect"];
  assert.equal(isPlateaued(recent, 50, 50), false);
});

test("a clear recent trend (not yet saturated) is NOT reported as a plateau", () => {
  const recent: BktOutcome[] = ["correct", "correct", "correct", "correct"];
  assert.equal(isPlateaued(recent, 0, 0), false);
});

test("no division by zero or NaN across zero/extreme inputs", () => {
  assert.ok(Number.isFinite(pfaScore(0, 0)));
  assert.ok(Number.isFinite(pfaProbability(0, 0)));
  assert.ok(Number.isFinite(pfaProbability(10_000, 0)));
  assert.ok(Number.isFinite(pfaProbability(0, 10_000)));
  const signal = computePracticeSignal(10_000, 10_000, Array(4).fill("correct") as BktOutcome[]);
  assert.ok(Number.isFinite(signal.pfaProbability!));
});

test("deterministic: identical input always produces identical output", () => {
  const a = computePracticeSignal(4, 2, ["correct", "incorrect", "correct", "correct"]);
  const b = computePracticeSignal(4, 2, ["correct", "incorrect", "correct", "correct"]);
  assert.deepEqual(a, b);
});

test("sigmoid and constants are sane", () => {
  assert.equal(sigmoid(0), 0.5);
  assert.ok(sigmoid(100) > 0.999);
  assert.ok(sigmoid(-100) < 0.001);
  assert.equal(PFA_PLATEAU_WINDOW, 4);
  assert.equal(PFA_PLATEAU_DELTA, 0.025);
});
