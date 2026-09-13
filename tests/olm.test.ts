import assert from "node:assert/strict";
import test from "node:test";
import { deriveMasteryStage } from "@/lib/learning/olm";

function input(overrides: Partial<Parameters<typeof deriveMasteryStage>[0]> = {}) {
  return { evidenceCount: 0, pMastery: null, cardState: null, retrievability: null, ...overrides };
}

test("evidence_count == 0 always returns NEW regardless of any other field", () => {
  assert.equal(deriveMasteryStage(input({ evidenceCount: 0, pMastery: 0.99, cardState: "review", retrievability: 0.01 })), "NEW");
});

test("REVIEW_DUE overrides every mastery-based stage whenever card_state != 'new' and retrievability < 0.40", () => {
  assert.equal(deriveMasteryStage(input({ evidenceCount: 10, pMastery: 0.95, cardState: "review", retrievability: 0.39 })), "REVIEW_DUE");
  assert.equal(deriveMasteryStage(input({ evidenceCount: 10, pMastery: 0.2, cardState: "relearning", retrievability: 0.1 })), "REVIEW_DUE");
});

test("REVIEW_DUE never fires for card_state == 'new' or null, even with low retrievability", () => {
  assert.notEqual(deriveMasteryStage(input({ evidenceCount: 5, pMastery: 0.5, cardState: "new", retrievability: 0.1 })), "REVIEW_DUE");
  assert.notEqual(deriveMasteryStage(input({ evidenceCount: 5, pMastery: 0.5, cardState: null, retrievability: null })), "REVIEW_DUE");
});

test("REVIEW_DUE never fires at exactly the boundary or above (>= 0.40 is not urgent)", () => {
  assert.notEqual(deriveMasteryStage(input({ evidenceCount: 5, pMastery: 0.9, cardState: "review", retrievability: 0.4 })), "REVIEW_DUE");
});

test("LEARNING: evidence present but below the adaptive floor (< 3), regardless of mastery", () => {
  assert.equal(deriveMasteryStage(input({ evidenceCount: 1, pMastery: 0.9 })), "LEARNING");
  assert.equal(deriveMasteryStage(input({ evidenceCount: 2, pMastery: null })), "LEARNING");
});

test("LEARNING: evidence sufficient but mastery below 0.40", () => {
  assert.equal(deriveMasteryStage(input({ evidenceCount: 5, pMastery: 0.39 })), "LEARNING");
});

test("DEVELOPING: sufficient evidence, mastery in [0.40, 0.70)", () => {
  assert.equal(deriveMasteryStage(input({ evidenceCount: 5, pMastery: 0.4 })), "DEVELOPING");
  assert.equal(deriveMasteryStage(input({ evidenceCount: 5, pMastery: 0.69 })), "DEVELOPING");
});

test("PROFICIENT: sufficient evidence, mastery in [0.70, 0.85)", () => {
  assert.equal(deriveMasteryStage(input({ evidenceCount: 3, pMastery: 0.7 })), "PROFICIENT");
  assert.equal(deriveMasteryStage(input({ evidenceCount: 3, pMastery: 0.84 })), "PROFICIENT");
});

test("MASTERED: sufficient evidence, mastery >= 0.85", () => {
  assert.equal(deriveMasteryStage(input({ evidenceCount: 3, pMastery: 0.85 })), "MASTERED");
  assert.equal(deriveMasteryStage(input({ evidenceCount: 100, pMastery: 0.98 })), "MASTERED");
});

test("boundary values resolve deterministically to the documented side of each stage (§34)", () => {
  assert.equal(deriveMasteryStage(input({ evidenceCount: 3, pMastery: 0.4 })), "DEVELOPING");
  assert.equal(deriveMasteryStage(input({ evidenceCount: 2, pMastery: 0.9 })), "LEARNING"); // evidence_count exactly below the floor
});
