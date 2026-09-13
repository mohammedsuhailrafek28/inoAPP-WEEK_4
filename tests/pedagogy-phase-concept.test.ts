import assert from "node:assert/strict";
import test from "node:test";
import { computePhaseTransition, type ConceptPhaseSignal } from "@/lib/pedagogy/phase";
import { selectConcept, type ConceptCandidateSignal } from "@/lib/pedagogy/select-concept";

const NOW = new Date("2026-01-15T00:00:00.000Z");

function phaseSignal(overrides: Partial<ConceptPhaseSignal> = {}): ConceptPhaseSignal {
  return { conceptId: "c1", evidenceCount: 0, pMastery: null, stability: null, lastReviewedAt: null, ...overrides };
}

// --- §17.1 phase FSM -----------------------------------------------------------------------------

test("zero concepts never transitions -- current phase holds", () => {
  assert.equal(computePhaseTransition("DIAGNOSTIC", [], NOW), "DIAGNOSTIC");
  assert.equal(computePhaseTransition("MAINTENANCE", [], NOW), "MAINTENANCE");
});

test("DIAGNOSTIC -> INSTRUCTION only once every concept has >= 1 evidence entry", () => {
  const partial = [phaseSignal({ evidenceCount: 1 }), phaseSignal({ conceptId: "c2", evidenceCount: 0 })];
  assert.equal(computePhaseTransition("DIAGNOSTIC", partial, NOW), "DIAGNOSTIC");
  const full = [phaseSignal({ evidenceCount: 1 }), phaseSignal({ conceptId: "c2", evidenceCount: 3 })];
  assert.equal(computePhaseTransition("DIAGNOSTIC", full, NOW), "INSTRUCTION");
});

test("INSTRUCTION -> MAINTENANCE only once every concept is mastered (>= 0.85)", () => {
  const partial = [phaseSignal({ pMastery: 0.9 }), phaseSignal({ conceptId: "c2", pMastery: 0.5 })];
  assert.equal(computePhaseTransition("INSTRUCTION", partial, NOW), "INSTRUCTION");
  const full = [phaseSignal({ pMastery: 0.9 }), phaseSignal({ conceptId: "c2", pMastery: 0.86 })];
  assert.equal(computePhaseTransition("INSTRUCTION", full, NOW), "MAINTENANCE");
});

test("MAINTENANCE -> INSTRUCTION when any mastered concept's retrievability decays below the routing threshold (0.50)", () => {
  const stable = [phaseSignal({ pMastery: 0.9, stability: 30, lastReviewedAt: NOW.toISOString() })]; // just reviewed -> retrievability ~1
  assert.equal(computePhaseTransition("MAINTENANCE", stable, NOW), "MAINTENANCE");
  const decayed = [phaseSignal({ pMastery: 0.9, stability: 1, lastReviewedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString() })];
  assert.equal(computePhaseTransition("MAINTENANCE", decayed, NOW), "INSTRUCTION");
});

test("MAINTENANCE ignores a non-mastered concept's decay entirely (guard is explicit, not assumed)", () => {
  const nonMastered = [phaseSignal({ pMastery: 0.5, stability: 1, lastReviewedAt: new Date(NOW.getTime() - 100 * 24 * 60 * 60 * 1000).toISOString() })];
  assert.equal(computePhaseTransition("MAINTENANCE", nonMastered, NOW), "MAINTENANCE");
});

// --- §17.2 concept selection ----------------------------------------------------------------------

function candidate(overrides: Partial<ConceptCandidateSignal> = {}): ConceptCandidateSignal {
  return { conceptId: "c1", conceptKey: "c1", displayName: "C1", evidenceCount: 0, pMastery: null, stability: null, lastReviewedAt: null, readinessReady: true, hasActiveMisconception: false, ...overrides };
}

test("NO_CONCEPTS_AVAILABLE when the candidate pool is empty", () => {
  const result = selectConcept("DIAGNOSTIC", [], null, NOW);
  assert.equal(result.reasonCode, "NO_CONCEPTS_AVAILABLE");
  assert.equal(result.conceptId, null);
});

test("override 1: retrievability < 0.30 force-selects, overriding the phase formula and anti-repeat", () => {
  const critical = candidate({ conceptId: "critical", pMastery: 0.9, stability: 1, lastReviewedAt: new Date(NOW.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString() });
  const other = candidate({ conceptId: "other", evidenceCount: 0 });
  const result = selectConcept("DIAGNOSTIC", [critical, other], "critical", NOW); // anti-repeat would normally exclude "critical"
  assert.equal(result.conceptId, "critical");
  assert.equal(result.reasonCode, "PRIORITY_RETENTION_CRITICAL");
});

test("override 2: active misconception is never excluded by anti-repeat and is prioritized above the ordinary formula", () => {
  const misconceptual = candidate({ conceptId: "m1", hasActiveMisconception: true, evidenceCount: 5 });
  const leastEvidence = candidate({ conceptId: "least", evidenceCount: 0 });
  const result = selectConcept("DIAGNOSTIC", [misconceptual, leastEvidence], "m1", NOW);
  assert.equal(result.conceptId, "m1");
  assert.equal(result.reasonCode, "PRIORITY_ACTIVE_MISCONCEPTION");
});

test("anti-repeat excludes the previous selection when >=2 candidates remain", () => {
  const a = candidate({ conceptId: "a", evidenceCount: 0 });
  const b = candidate({ conceptId: "b", evidenceCount: 0 });
  const result = selectConcept("DIAGNOSTIC", [a, b], "a", NOW);
  assert.equal(result.conceptId, "b");
});

test("anti-repeat never empties the pool -- a single-concept subject always re-selects it", () => {
  const only = candidate({ conceptId: "only", evidenceCount: 2 });
  const result = selectConcept("DIAGNOSTIC", [only], "only", NOW);
  assert.equal(result.conceptId, "only");
});

test("DIAGNOSTIC: least-evidence-first, alphabetical tie-break", () => {
  const a = candidate({ conceptId: "a", conceptKey: "beta", evidenceCount: 2 });
  const b = candidate({ conceptId: "b", conceptKey: "alpha", evidenceCount: 1 });
  const c = candidate({ conceptId: "c", conceptKey: "gamma", evidenceCount: 1 });
  const result = selectConcept("DIAGNOSTIC", [a, b, c], null, NOW);
  assert.equal(result.conceptId, "b"); // tied at evidence=1 with c, "alpha" < "gamma"
  assert.equal(result.reasonCode, "PHASE_DIAGNOSTIC_LEAST_EVIDENCE");
});

test("INSTRUCTION: argmax(relevance*(1-mastery)) restricted to 'ready' concepts", () => {
  const notReady = candidate({ conceptId: "blocked", pMastery: 0.1, readinessReady: false });
  const readyLowMastery = candidate({ conceptId: "ready-low", pMastery: 0.3, readinessReady: true });
  const readyHighMastery = candidate({ conceptId: "ready-high", pMastery: 0.8, readinessReady: true });
  const result = selectConcept("INSTRUCTION", [notReady, readyLowMastery, readyHighMastery], null, NOW);
  assert.equal(result.conceptId, "ready-low"); // lowest mastery among READY concepts wins -- the blocked concept is never picked
  assert.equal(result.reasonCode, "PHASE_INSTRUCTION_ARGMAX");
});

test("INSTRUCTION falls back to the full pool when nothing is 'ready' (never returns nothing)", () => {
  const onlyBlocked = candidate({ conceptId: "blocked", pMastery: 0.5, readinessReady: false });
  const result = selectConcept("INSTRUCTION", [onlyBlocked], null, NOW);
  assert.equal(result.conceptId, "blocked");
});

test("MAINTENANCE: argmax(1-retrievability) restricted to mastered concepts", () => {
  // Deliberately healthy retrievability (recently reviewed) so this candidate never trips override
  // 1 (§17.2: "ANY concept with retrievability < RETENTION_CRITICAL is force-selected," regardless
  // of mastery) -- isolating what's actually under test, the MAINTENANCE argmax's own mastery gate.
  const notMastered = candidate({ conceptId: "not-mastered", pMastery: 0.5, stability: 30, lastReviewedAt: NOW.toISOString() });
  const masteredFresh = candidate({ conceptId: "fresh", pMastery: 0.9, stability: 30, lastReviewedAt: NOW.toISOString() });
  const masteredDecayed = candidate({ conceptId: "decayed", pMastery: 0.9, stability: 5, lastReviewedAt: new Date(NOW.getTime() - 20 * 24 * 60 * 60 * 1000).toISOString() });
  const result = selectConcept("MAINTENANCE", [notMastered, masteredFresh, masteredDecayed], null, NOW);
  assert.equal(result.conceptId, "decayed"); // most-decayed MASTERED concept wins; the non-mastered one is never eligible here
  assert.equal(result.reasonCode, "PHASE_MAINTENANCE_ARGMAX");
});

test("MAINTENANCE with no mastered concept in the pool falls back to least-evidence-first rather than returning nothing", () => {
  const onlyNonMastered = candidate({ conceptId: "nm", pMastery: 0.4, evidenceCount: 2 });
  const result = selectConcept("MAINTENANCE", [onlyNonMastered], null, NOW);
  assert.equal(result.conceptId, "nm");
});
