import assert from "node:assert/strict";
import test from "node:test";
import { deriveActivityType, packPlan, PlanValidationError, type PlanCandidate } from "@/lib/plan/budget";

function candidate(overrides: Partial<PlanCandidate> = {}): PlanCandidate {
  return {
    conceptId: "c1",
    conceptKey: "concept-1",
    displayName: "Concept 1",
    subject: "algorithms",
    reasonCodes: ["MASTERY_DEVELOPING"],
    ...overrides,
  };
}

// --- deriveActivityType: pure, deterministic mapping -------------------------------------------

test("deriveActivityType: PREREQUISITE_BLOCKER maps to learn regardless of other reasons present", () => {
  assert.equal(deriveActivityType(["PREREQUISITE_BLOCKER", "REVIEW_DUE"]), "learn");
});

test("deriveActivityType: REVIEW_DUE maps to review when no prerequisite blocker is present", () => {
  assert.equal(deriveActivityType(["REVIEW_DUE", "PRACTICE_PLATEAU"]), "review");
});

test("deriveActivityType: every other reason (and no reason at all) maps to practice", () => {
  assert.equal(deriveActivityType(["ACTIVE_MISCONCEPTION"]), "practice");
  assert.equal(deriveActivityType(["TRANSFER_NOT_DEMONSTRATED"]), "practice");
  assert.equal(deriveActivityType(["PRACTICE_PLATEAU"]), "practice");
  assert.equal(deriveActivityType(["MASTERY_DEVELOPING"]), "practice");
  assert.equal(deriveActivityType([]), "practice");
});

// --- packPlan: budget fitting -------------------------------------------------------------------

test("60-minute budget: fits as many top-ordered candidates as the budget allows, never exceeding it", () => {
  const candidates = [
    candidate({ conceptId: "a", conceptKey: "a", reasonCodes: ["REVIEW_DUE"] }), // review, 15
    candidate({ conceptId: "b", conceptKey: "b", reasonCodes: ["PREREQUISITE_BLOCKER"] }), // learn, 20
    candidate({ conceptId: "c", conceptKey: "c", reasonCodes: ["TRANSFER_NOT_DEMONSTRATED"] }), // practice, 15
    candidate({ conceptId: "d", conceptKey: "d", reasonCodes: ["PRACTICE_PLATEAU"] }), // practice, 15 -- would push total to 65
    candidate({ conceptId: "e", conceptKey: "e", reasonCodes: ["MASTERY_DEVELOPING"] }), // practice, 15 -- never even reached
  ];
  const result = packPlan(candidates, 60);
  assert.deepEqual(result.items.map((i) => i.conceptId), ["a", "b", "c"]);
  assert.equal(result.estimatedMinutes, 50);
  assert.ok(result.estimatedMinutes <= 60);
});

test("exact-fit budget: a budget matching the cumulative duration exactly includes every fitting item", () => {
  const candidates = [
    candidate({ conceptId: "a", conceptKey: "a", reasonCodes: ["REVIEW_DUE"] }), // 15
    candidate({ conceptId: "b", conceptKey: "b", reasonCodes: ["PREREQUISITE_BLOCKER"] }), // 20
    candidate({ conceptId: "c", conceptKey: "c", reasonCodes: ["TRANSFER_NOT_DEMONSTRATED"] }), // 15
  ];
  const result = packPlan(candidates, 50); // 15 + 20 + 15 == 50
  assert.deepEqual(result.items.map((i) => i.conceptId), ["a", "b", "c"]);
  assert.equal(result.estimatedMinutes, 50);
});

test("insufficient budget: a valid but too-small budget yields an empty, non-throwing plan", () => {
  const candidates = [candidate({ conceptId: "a", reasonCodes: ["REVIEW_DUE"] })]; // 15 minutes
  const result = packPlan(candidates, 5); // smallest valid budget, smaller than any activity
  assert.deepEqual(result.items, []);
  assert.equal(result.estimatedMinutes, 0);
});

test("zero/invalid budget: out-of-bounds or non-numeric values are rejected, never silently coerced", () => {
  const candidates = [candidate()];
  assert.throws(() => packPlan(candidates, 0), PlanValidationError);
  assert.throws(() => packPlan(candidates, -10), PlanValidationError);
  assert.throws(() => packPlan(candidates, Number.NaN), PlanValidationError);
  assert.throws(() => packPlan(candidates, 4), PlanValidationError); // below the minimum
  assert.throws(() => packPlan(candidates, 300), PlanValidationError); // above the maximum
});

test("handles very small (but valid) budgets gracefully", () => {
  const candidates = [candidate({ conceptId: "a", reasonCodes: ["REVIEW_DUE"] })];
  const result = packPlan(candidates, 5);
  assert.deepEqual(result.items, []);
});

// --- packPlan: ordering invariants ---------------------------------------------------------------

test("prerequisite ordering: a blocker scheduled before its dependent stays before it when both fit", () => {
  const candidates = [
    candidate({ conceptId: "blocker", conceptKey: "blocker", reasonCodes: ["PREREQUISITE_BLOCKER"] }), // learn, 20
    candidate({ conceptId: "dependent", conceptKey: "dependent", reasonCodes: ["MASTERY_DEVELOPING"] }), // practice, 15
  ];
  const result = packPlan(candidates, 60);
  assert.deepEqual(result.items.map((i) => i.conceptId), ["blocker", "dependent"]);
  assert.equal(result.items[0].order, 1);
  assert.equal(result.items[1].order, 2);
});

test("prerequisite ordering: the pack stops rather than skipping an unfit blocker to seat its smaller dependent alone", () => {
  const candidates = [
    candidate({ conceptId: "blocker", conceptKey: "blocker", reasonCodes: ["PREREQUISITE_BLOCKER"] }), // learn, 20 -- does not fit
    candidate({ conceptId: "dependent", conceptKey: "dependent", reasonCodes: ["REVIEW_DUE"] }), // review, 15 -- would fit alone
  ];
  const result = packPlan(candidates, 15);
  // Never [dependent] -- that would present a concept ahead of/without its own required prerequisite.
  assert.deepEqual(result.items, []);
});

test("stable deterministic ordering: identical input produces identical output across repeated calls", () => {
  const candidates = [
    candidate({ conceptId: "a", conceptKey: "a", reasonCodes: ["REVIEW_DUE"] }),
    candidate({ conceptId: "b", conceptKey: "b", reasonCodes: ["PREREQUISITE_BLOCKER"] }),
    candidate({ conceptId: "c", conceptKey: "c", reasonCodes: ["ACTIVE_MISCONCEPTION"] }),
  ];
  const first = packPlan(candidates, 60);
  const second = packPlan(candidates, 60);
  assert.deepEqual(first, second);
});

test("no budget overflow across a range of budgets", () => {
  const candidates = [
    candidate({ conceptId: "a", conceptKey: "a", reasonCodes: ["REVIEW_DUE"] }),
    candidate({ conceptId: "b", conceptKey: "b", reasonCodes: ["PREREQUISITE_BLOCKER"] }),
    candidate({ conceptId: "c", conceptKey: "c", reasonCodes: ["ACTIVE_MISCONCEPTION"] }),
    candidate({ conceptId: "d", conceptKey: "d", reasonCodes: ["PRACTICE_PLATEAU"] }),
    candidate({ conceptId: "e", conceptKey: "e", reasonCodes: ["TRANSFER_NOT_DEMONSTRATED"] }),
  ];
  for (const budget of [5, 10, 15, 20, 25, 30, 45, 60, 90, 120, 240]) {
    const result = packPlan(candidates, budget);
    assert.ok(result.estimatedMinutes <= budget, `budget=${budget} produced ${result.estimatedMinutes}`);
    const summed = result.items.reduce((sum, item) => sum + item.estimatedMinutes, 0);
    assert.equal(summed, result.estimatedMinutes);
  }
});

test("no accidental duplicate activities: a repeated conceptId collapses to its first, highest-priority occurrence", () => {
  const candidates = [
    candidate({ conceptId: "x", conceptKey: "x", reasonCodes: ["REVIEW_DUE"] }),
    candidate({ conceptId: "x", conceptKey: "x", reasonCodes: ["PRACTICE_PLATEAU"] }), // same concept, e.g. also in transferPractice
    candidate({ conceptId: "y", conceptKey: "y", reasonCodes: ["MASTERY_DEVELOPING"] }),
  ];
  const result = packPlan(candidates, 60);
  assert.equal(result.items.filter((i) => i.conceptId === "x").length, 1);
  assert.deepEqual(result.items.find((i) => i.conceptId === "x")!.reasonCodes, ["REVIEW_DUE"]);
  assert.deepEqual(result.items.map((i) => i.conceptId), ["x", "y"]);
});

test("existing reason metadata preserved: output reasonCodes match the input candidate verbatim, never re-derived", () => {
  const candidates = [candidate({ conceptId: "a", reasonCodes: ["ACTIVE_MISCONCEPTION", "REVIEW_DUE"] })];
  const result = packPlan(candidates, 60);
  assert.deepEqual(result.items[0].reasonCodes, ["ACTIVE_MISCONCEPTION", "REVIEW_DUE"]);
});
