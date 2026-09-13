import assert from "node:assert/strict";
import test from "node:test";
import {
  RetentionConfigError,
  applyReview,
  calculateRetrievability,
  daysBetween,
  getRetentionUrgency,
  getReviewStatus,
  initialDifficulty,
  initialStability,
  nextIntervalDays,
  nextStabilityOnLapse,
  nextStabilityOnSuccess,
  ratingFromOutcome,
} from "@/lib/learning/retention";

// Independently recomputed from ARCHITECTURE.md §10.2's own published constants -- NOT
// imported from lib/learning/constants.ts -- so these tests catch a real drift in the production
// weights, not just an internally-consistent tautology (the same hand-verification style Phase 3's
// BKT test and Phase 4's IRT test already used).
const W0 = 0.4072;
const W2 = 3.1262;
const W4 = 7.2102;
const W5 = 0.5316;
const W8 = 1.533;
const W9 = 0.1544;
const W10 = 1.0166;
const W11 = 1.921;
const W12 = 0.0854;
const W13 = 0.2698;
const W14 = 2.2694;
const FACTOR = 19 / 81;
const DESIRED_RETENTION = 0.9;

function refRetrievability(elapsedDays: number, stability: number): number {
  return Math.pow(1 + (FACTOR * elapsedDays) / stability, -0.5);
}
function refInitialDifficulty(r: number): number {
  return Math.min(10, Math.max(1, W4 - Math.exp(W5 * (r - 1)) + 1));
}
function refNextStabilityOnSuccess(s: number, d: number, r: number): number {
  return s * (Math.exp(W8) * (11 - d) * Math.pow(s, -W9) * (Math.exp(W10 * (1 - r)) - 1) + 1);
}
function refNextStabilityOnLapse(s: number, d: number, r: number): number {
  return W11 * Math.pow(d, -W12) * (Math.pow(s + 1, W13) - 1) * Math.exp(W14 * (1 - r));
}
function refNextIntervalDays(s: number): number {
  return Math.max(1, Math.round((s / FACTOR) * (Math.pow(DESIRED_RETENTION, -2) - 1)));
}

// --- Rating mapping (Step 10) --------------------------------------------------------------------

test("ratingFromOutcome maps correct->good and incorrect->again, the only two ratings this design produces", () => {
  assert.equal(ratingFromOutcome("correct"), "good");
  assert.equal(ratingFromOutcome("incorrect"), "again");
});

// --- Initialization (§10.2) ----------------------------------------------------------------------

test("initialStability matches FSRS's own published w0/w2 exactly", () => {
  assert.equal(initialStability("good"), W2);
  assert.equal(initialStability("again"), W0);
});

test("initialDifficulty matches the published formula for both Again (r=1) and Good (r=3), Again harder than Good", () => {
  assert.ok(Math.abs(initialDifficulty("again") - refInitialDifficulty(1)) < 1e-9);
  assert.ok(Math.abs(initialDifficulty("good") - refInitialDifficulty(3)) < 1e-9);
  assert.ok(initialDifficulty("again") > initialDifficulty("good"));
});

test("initialDifficulty is clamped to [1, 10]", () => {
  assert.ok(initialDifficulty("again") <= 10 && initialDifficulty("again") >= 1);
  assert.ok(initialDifficulty("good") <= 10 && initialDifficulty("good") >= 1);
});

// --- Retrievability (§10.2) ----------------------------------------------------------------------

test("retrievability is exactly 1 immediately after review and decays monotonically with elapsed time", () => {
  assert.equal(calculateRetrievability(0, 3.1262), 1);
  const r10 = calculateRetrievability(10, 3.1262);
  const r20 = calculateRetrievability(20, 3.1262);
  assert.ok(r10 < 1 && r10 > 0);
  assert.ok(r20 < r10);
  assert.ok(Math.abs(r10 - refRetrievability(10, 3.1262)) < 1e-9);
});

test("higher stability decays more slowly for the same elapsed time", () => {
  const lowStability = calculateRetrievability(30, 1);
  const highStability = calculateRetrievability(30, 10);
  assert.ok(highStability > lowStability);
});

test("retrievability floors stability at 1e-9 instead of dividing by zero or producing NaN", () => {
  const result = calculateRetrievability(5, 0);
  assert.ok(Number.isFinite(result));
  assert.ok(result >= 0 && result <= 1);
});

test("retrievability rejects negative elapsed days", () => {
  assert.throws(() => calculateRetrievability(-1, 3), RetentionConfigError);
});

// --- Stability transitions (§10.2) ---------------------------------------------------------------

test("nextStabilityOnSuccess matches the published recall-stability formula", () => {
  const s = nextStabilityOnSuccess(3.1262, 5.3, 0.9);
  assert.ok(Math.abs(s - refNextStabilityOnSuccess(3.1262, 5.3, 0.9)) < 1e-9);
  assert.ok(s > 0);
});

test("nextStabilityOnSuccess grows stability further when retrievability was lower (a harder-won recall is stronger evidence)", () => {
  const highR = nextStabilityOnSuccess(3, 5, 0.95);
  const lowR = nextStabilityOnSuccess(3, 5, 0.4);
  assert.ok(lowR > highR);
});

test("nextStabilityOnLapse matches the published forgetting-stability formula and is smaller than the prior stability", () => {
  const s = nextStabilityOnLapse(10, 5, 0.5);
  assert.ok(Math.abs(s - refNextStabilityOnLapse(10, 5, 0.5)) < 1e-9);
  assert.ok(s < 10);
  assert.ok(s > 0);
});

test("stability transition formulas reject non-finite/invalid stability, difficulty, or retrievability", () => {
  assert.throws(() => nextStabilityOnSuccess(0, 5, 0.5), RetentionConfigError);
  assert.throws(() => nextStabilityOnSuccess(-1, 5, 0.5), RetentionConfigError);
  assert.throws(() => nextStabilityOnSuccess(3, 0, 0.5), RetentionConfigError);
  assert.throws(() => nextStabilityOnSuccess(3, 11, 0.5), RetentionConfigError);
  assert.throws(() => nextStabilityOnSuccess(3, 5, 1.5), RetentionConfigError);
  assert.throws(() => nextStabilityOnLapse(3, 5, -0.1), RetentionConfigError);
});

// --- Next interval (§10.2) -----------------------------------------------------------------------

test("nextIntervalDays matches the published formula and is never less than 1 day", () => {
  assert.equal(nextIntervalDays(0.0001), refNextIntervalDays(0.0001));
  assert.equal(nextIntervalDays(0.0001), 1);
  assert.ok(Math.abs(nextIntervalDays(20) - refNextIntervalDays(20)) < 1e-9);
});

test("with the locked constants (desiredRetention=0.9), nextIntervalDays(S) reduces to max(1, round(S)) -- a documented algebraic identity, not a shortcut taken in the implementation", () => {
  // Values deliberately avoid exact half-integers (e.g. 7.5) -- Math.pow(0.9, -2) has a tiny
  // floating-point error relative to the exact 19/81 identity, which could flip Math.round's
  // half-up boundary for a value that lands precisely on .5.
  for (const s of [0.4072, 3.1262, 6.8, 15, 0.9]) {
    assert.equal(nextIntervalDays(s), Math.max(1, Math.round(s)));
  }
});

// --- Retention urgency (§10.3) -------------------------------------------------------------------

test("retention urgency uses the locked §10.3 tiers: >=0.50 ok, [0.30,0.50) warning, <0.30 critical", () => {
  assert.equal(getRetentionUrgency(1).level, "ok");
  assert.equal(getRetentionUrgency(0.5).level, "ok");
  assert.equal(getRetentionUrgency(0.49).level, "warning");
  assert.equal(getRetentionUrgency(0.3).level, "warning");
  assert.equal(getRetentionUrgency(0.29).level, "critical");
  assert.equal(getRetentionUrgency(0).level, "critical");
});

test("retention urgency rejects an out-of-range retrievability", () => {
  assert.throws(() => getRetentionUrgency(1.1), RetentionConfigError);
  assert.throws(() => getRetentionUrgency(-0.1), RetentionConfigError);
});

// --- Review status (Step 16) ----------------------------------------------------------------------

test("getReviewStatus: no schedule yet -> not_started, future -> scheduled, past -> due, well past -> overdue", () => {
  const now = new Date("2026-06-15T00:00:00.000Z");
  assert.equal(getReviewStatus(null, now), "not_started");
  assert.equal(getReviewStatus(new Date("2026-06-20T00:00:00.000Z"), now), "scheduled");
  assert.equal(getReviewStatus(new Date("2026-06-15T00:00:00.000Z"), now), "due");
  assert.equal(getReviewStatus(new Date("2026-06-14T00:00:00.000Z"), now), "due");
  assert.equal(getReviewStatus(new Date("2026-06-10T00:00:00.000Z"), now), "overdue");
});

// --- Temporal edge cases (Step 17) -----------------------------------------------------------------

test("daysBetween is timezone-independent (UTC epoch math) and rejects a negative gap", () => {
  const a = new Date("2026-02-27T12:00:00.000Z");
  const b = new Date("2026-03-01T12:00:00.000Z"); // crosses a month boundary, non-leap Feb
  assert.equal(daysBetween(a, b), 2);
  assert.throws(() => daysBetween(b, a), RetentionConfigError);
});

test("daysBetween handles a leap-year February boundary correctly", () => {
  const a = new Date("2028-02-28T00:00:00.000Z"); // 2028 is a leap year
  const b = new Date("2028-03-01T00:00:00.000Z");
  assert.equal(daysBetween(a, b), 2); // Feb 29 exists in between
});

test("daysBetween handles a year boundary correctly", () => {
  const a = new Date("2026-12-30T00:00:00.000Z");
  const b = new Date("2027-01-02T00:00:00.000Z");
  assert.equal(daysBetween(a, b), 3);
});

// --- Full state machine (§10.1/§10.2) --------------------------------------------------------------

test("applyReview: a brand-new card's first Good review goes straight to 'review' with a scheduled next review", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const result = applyReview(null, "good", now);
  assert.equal(result.cardState, "review");
  assert.equal(result.stability, W2);
  assert.equal(result.lapsed, false);
  assert.equal(result.retrievabilityBefore, null);
  assert.equal(result.elapsedDays, 0);
  assert.ok(result.nextReviewAt.getTime() > now.getTime());
});

test("applyReview: a brand-new card's first Again review goes to 'learning', due immediately", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const result = applyReview(null, "again", now);
  assert.equal(result.cardState, "learning");
  assert.equal(result.stability, W0);
  assert.equal(result.nextReviewAt.getTime(), now.getTime());
});

test("applyReview: staying in 'learning' on a repeated Again leaves stability/difficulty unchanged, still due now", () => {
  const t0 = new Date("2026-01-01T00:00:00.000Z");
  const t1 = new Date("2026-01-01T00:10:00.000Z");
  const first = applyReview(null, "again", t0);
  const second = applyReview({ stability: first.stability, difficulty: first.difficulty, cardState: first.cardState, lastReviewedAt: t0 }, "again", t1);
  assert.equal(second.cardState, "learning");
  assert.equal(second.stability, first.stability);
  assert.equal(second.difficulty, first.difficulty);
  assert.equal(second.nextReviewAt.getTime(), t1.getTime());
});

test("applyReview: a Good review that graduates 'learning' -> 'review' recomputes stability via the recall formula", () => {
  const t0 = new Date("2026-01-01T00:00:00.000Z");
  const t1 = new Date("2026-01-03T00:00:00.000Z"); // 2 days later
  const first = applyReview(null, "again", t0); // -> learning, S=w0, D=initialDifficulty(again)
  const second = applyReview({ stability: first.stability, difficulty: first.difficulty, cardState: first.cardState, lastReviewedAt: t0 }, "good", t1);
  assert.equal(second.cardState, "review");
  assert.equal(second.lapsed, false);
  const r = refRetrievability(2, first.stability);
  assert.ok(Math.abs((second.retrievabilityBefore as number) - r) < 1e-9);
  assert.ok(Math.abs(second.stability - refNextStabilityOnSuccess(first.stability, first.difficulty, r)) < 1e-9);
  assert.equal(second.difficulty, first.difficulty); // difficulty held fixed after init (§10.2 -- no "next difficulty" formula)
});

test("applyReview: a Good review while already in 'review' stays in 'review' and grows stability", () => {
  const t0 = new Date("2026-01-01T00:00:00.000Z");
  const t1 = new Date("2026-01-05T00:00:00.000Z");
  const first = applyReview(null, "good", t0); // -> review, S=w2
  const second = applyReview({ stability: first.stability, difficulty: first.difficulty, cardState: first.cardState, lastReviewedAt: t0 }, "good", t1);
  assert.equal(second.cardState, "review");
  assert.equal(second.lapsed, false);
  assert.ok(second.stability > 0);
});

test("applyReview: an Again from 'review' is a genuine lapse -> 'relearning', stability shrinks via the forgetting formula, due immediately", () => {
  const t0 = new Date("2026-01-01T00:00:00.000Z");
  const t1 = new Date("2026-01-10T00:00:00.000Z");
  const first = applyReview(null, "good", t0); // -> review
  const second = applyReview({ stability: first.stability, difficulty: first.difficulty, cardState: first.cardState, lastReviewedAt: t0 }, "again", t1);
  assert.equal(second.cardState, "relearning");
  assert.equal(second.lapsed, true);
  assert.ok(second.stability < first.stability);
  assert.equal(second.nextReviewAt.getTime(), t1.getTime());
  const r = refRetrievability(9, first.stability);
  assert.ok(Math.abs(second.stability - refNextStabilityOnLapse(first.stability, first.difficulty, r)) < 1e-9);
});

test("applyReview rejects an invalid rating", () => {
  assert.throws(() => applyReview(null, "hard" as never, new Date()), RetentionConfigError);
});

test("applyReview is deterministic -- identical inputs produce byte-identical outputs", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const prior = { stability: 5, difficulty: 6, cardState: "review" as const, lastReviewedAt: new Date("2025-12-20T00:00:00.000Z") };
  const a = applyReview(prior, "good", now);
  const b = applyReview(prior, "good", now);
  assert.deepEqual(a, b);
});
