import assert from "node:assert/strict";
import test from "node:test";
import { buildBoundedLearnerContext, type LearnerContextInput } from "@/lib/learning/context-builder";

function baseInput(overrides: Partial<LearnerContextInput> = {}): LearnerContextInput {
  return {
    profile: { academicLevel: "Undergraduate", preferredExplanationStyle: "simple", preferredPace: "standard" },
    pedagogicalAction: "EXPLAIN",
    scaffoldingLevel: "STANDARD",
    weakConcepts: [],
    activeMisconception: null,
    narrativeMemory: null,
    currentConcept: null,
    ...overrides,
  };
}

test("always-included fixed fields are present even with nothing else supplied", () => {
  const result = buildBoundedLearnerContext(baseInput());
  assert.match(result.text, /Undergraduate/);
  assert.match(result.text, /EXPLAIN/);
  assert.match(result.text, /STANDARD/);
  assert.deepEqual(result.droppedSections, []);
});

test("optional sections not present in the input are simply absent, not counted as 'dropped'", () => {
  const result = buildBoundedLearnerContext(baseInput());
  assert.deepEqual(result.includedSections, []);
  assert.deepEqual(result.droppedSections, []);
});

test("all four optional sections render when everything is supplied and the budget is generous", () => {
  const result = buildBoundedLearnerContext(
    baseInput({
      weakConcepts: [{ conceptKey: "a", displayName: "Alpha", stage: "LEARNING" }],
      activeMisconception: { tag: "off_by_one", description: "confuses boundary conditions" },
      narrativeMemory: "Student prefers worked examples.",
      currentConcept: { displayName: "Beta", stage: "PROFICIENT" },
    }),
  );
  assert.deepEqual(result.includedSections, ["weakConcepts", "activeMisconception", "narrativeMemory", "currentConcept"]);
  assert.match(result.text, /Alpha/);
  assert.match(result.text, /off_by_one|confuses boundary/);
  assert.match(result.text, /worked examples/);
  assert.match(result.text, /Beta - PROFICIENT/);
});

test("§22's exact drop order under a tiny budget: weakConcepts dropped first, currentConcept dropped last", () => {
  const full = baseInput({
    weakConcepts: [{ conceptKey: "a", displayName: "Alpha", stage: "LEARNING" }],
    activeMisconception: { tag: "off_by_one", description: "confuses boundary conditions on the very first iteration of the loop" },
    narrativeMemory: "Student strongly prefers seeing a fully worked numeric example before any abstract explanation.",
    currentConcept: { displayName: "Beta", stage: "PROFICIENT" },
  });

  // Budget only large enough for the fixed block + the current-concept line.
  const fixedLength = buildBoundedLearnerContext({ ...full, weakConcepts: [], activeMisconception: null, narrativeMemory: null, currentConcept: null }).text.length;
  const currentConceptLine = "Current concept status: Beta - PROFICIENT.";
  const tightBudget = fixedLength + currentConceptLine.length + 1;

  const result = buildBoundedLearnerContext(full, tightBudget);
  assert.deepEqual(result.includedSections, ["currentConcept"]);
  assert.deepEqual(result.droppedSections, ["weakConcepts", "activeMisconception", "narrativeMemory"]);
  assert.ok(result.length <= tightBudget);
});

test("an extremely tight budget drops everything, including currentConcept, 'only if literally nothing else fits'", () => {
  const full = baseInput({
    weakConcepts: [{ conceptKey: "a", displayName: "Alpha", stage: "LEARNING" }],
    currentConcept: { displayName: "Beta", stage: "PROFICIENT" },
  });
  const result = buildBoundedLearnerContext(full, 1);
  assert.deepEqual(result.includedSections, []);
  assert.deepEqual(result.droppedSections, ["weakConcepts", "currentConcept"]);
});

test("never exceeds the configured budget, for any budget at or above the always-included fixed block's own length", () => {
  const full = baseInput({
    weakConcepts: [{ conceptKey: "a", displayName: "Alpha", stage: "LEARNING" }],
    activeMisconception: { tag: "t", description: "d".repeat(100) },
    narrativeMemory: "n".repeat(200),
    currentConcept: { displayName: "Beta", stage: "PROFICIENT" },
  });
  const fixedOnlyLength = buildBoundedLearnerContext({ ...full, weakConcepts: [], activeMisconception: null, narrativeMemory: null, currentConcept: null }).text.length;
  for (const budget of [fixedOnlyLength, 300, 1500].filter((b) => b >= fixedOnlyLength)) {
    const result = buildBoundedLearnerContext(full, budget);
    assert.ok(result.length <= budget, `budget ${budget}: got length ${result.length}`);
  }
});

test("the always-included fixed block is exempt from the budget by design -- an absurdly tiny budget still returns it whole, never truncated mid-sentence", () => {
  const result = buildBoundedLearnerContext(baseInput(), 1);
  assert.ok(result.length > 1);
  assert.deepEqual(result.includedSections, []);
});

// §23's weakness-ranking formula moved to lib/learning/recommendations.ts in Phase 11 (the
// architecture's own canonical §23 module, §29) -- see tests/recommendations.test.ts. This file
// now covers only §22's bounded-context concerns.
