import assert from "node:assert/strict";
import test from "node:test";
import { computeRevisionPriority, deriveRevisionReasonCodes, formatRevisionSummary, rankRevisionCandidates, getRevisionRecommendations, type RevisionCandidateSignal } from "@/lib/learning/recommendations";
import { createFakeLearningSupabase } from "./support/fake-learning-db";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { createOrResolveConcept, addPrerequisite } from "@/lib/learning/concepts";
import { recordScoredOutcomeWithRetention } from "@/lib/learning/reviews";
import { recordLearningEvent } from "@/lib/learning/events";
import { recordMisconceptionEvidence } from "@/lib/learning/misconceptions";

function signal(overrides: Partial<RevisionCandidateSignal> = {}): RevisionCandidateSignal {
  return { conceptId: "c1", conceptKey: "c", displayName: "C", subject: "Data Structures", evidenceCount: 5, pMastery: 0.5, cardState: null, retrievability: null, retentionUrgencyLevel: null, misconceptionActive: false, pfaPlateaued: false, ...overrides };
}

// --- §23's exact formula, pure ---------------------------------------------------------------------

test("evidence_count == 0 is excluded entirely from ranking, never merely ranked last", () => {
  assert.equal(computeRevisionPriority(signal({ evidenceCount: 0 })), null);
  const ranked = rankRevisionCandidates([signal({ conceptId: "zero", conceptKey: "zero", evidenceCount: 0 }), signal({ conceptId: "real", conceptKey: "real", evidenceCount: 3 })]);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].conceptKey, "real");
});

test("lower mastery, critical retention, and active misconception each raise priority (§23's weighted terms)", () => {
  const low = computeRevisionPriority(signal({ pMastery: 0.9 }))!;
  const high = computeRevisionPriority(signal({ pMastery: 0.1 }))!;
  assert.ok(high > low);

  const noUrgency = computeRevisionPriority(signal({ retentionUrgencyLevel: null }))!;
  const critical = computeRevisionPriority(signal({ retentionUrgencyLevel: "critical" }))!;
  assert.ok(critical > noUrgency);

  const noMisconception = computeRevisionPriority(signal({ misconceptionActive: false }))!;
  const withMisconception = computeRevisionPriority(signal({ misconceptionActive: true }))!;
  assert.ok(withMisconception > noMisconception);

  const noPlateau = computeRevisionPriority(signal({ pfaPlateaued: false }))!;
  const plateaued = computeRevisionPriority(signal({ pfaPlateaued: true }))!;
  assert.ok(plateaued > noPlateau);
});

test("rankRevisionCandidates orders by priority desc, alphabetical tie-break, deterministic", () => {
  const signals = [signal({ conceptId: "b", conceptKey: "beta", pMastery: 0.5 }), signal({ conceptId: "a", conceptKey: "alpha", pMastery: 0.5 }), signal({ conceptId: "g", conceptKey: "gamma", pMastery: 0.9 })];
  const ranked = rankRevisionCandidates(signals);
  assert.deepEqual(ranked.map((r) => r.conceptKey), ["alpha", "beta", "gamma"]); // tied priority -> alphabetical; gamma (higher mastery) last
});

test("no score-soup structural check: priority is a pure function of exactly §23's five named terms, nothing else", () => {
  // Two signals identical except for a field §23 does NOT reference must produce identical priority.
  const a = signal({ conceptId: "x", conceptKey: "x", displayName: "X-long-name-should-not-matter" });
  const b = signal({ conceptId: "x", conceptKey: "x", displayName: "Y" });
  assert.equal(computeRevisionPriority(a), computeRevisionPriority(b));
});

test("deriveRevisionReasonCodes: one code per contributing signal, deterministic", () => {
  assert.deepEqual(deriveRevisionReasonCodes(signal({ pMastery: 0.9, retentionUrgencyLevel: null, misconceptionActive: false, pfaPlateaued: false })), []);
  assert.deepEqual(deriveRevisionReasonCodes(signal({ pMastery: 0.5, retentionUrgencyLevel: "critical", misconceptionActive: true, pfaPlateaued: true })), ["MASTERY_DEVELOPING", "REVIEW_DUE", "ACTIVE_MISCONCEPTION", "PRACTICE_PLATEAU"]);
});

test("formatRevisionSummary matches §23's exact output template", () => {
  const summary = formatRevisionSummary("Rabin-Karp", 0.437, ["ACTIVE_MISCONCEPTION"]);
  assert.equal(summary, "Review **Rabin-Karp** — mastery 44%, a recurring error pattern is still active.");
});

// --- DB-backed: prerequisite ordering, bounded output, transfer-practice (Steps 21-23, mandatory) ---

async function setup() {
  const fake = createFakeLearningSupabase();
  const supabase = fake as never;
  const profile = await getOrCreateDefaultProfile({ supabase });
  return { supabase, fake, studentId: profile.id };
}

test("Step 21 (mandatory): a blocking prerequisite is recommended BEFORE the concept it blocks, even with zero evidence of its own", async () => {
  const { supabase, studentId } = await setup();
  const { concept: prereq } = await createOrResolveConcept({ subject: "Data Structures", displayName: "Arrays" }, { supabase });
  const { concept: target } = await createOrResolveConcept({ subject: "Data Structures", displayName: "Binary Search" }, { supabase });
  await addPrerequisite(target.id, prereq.id, { supabase });
  // Target has real evidence (so it would normally qualify for the ranked list); prereq has none.
  for (let i = 0; i < 3; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId: target.id, outcome: "incorrect", difficulty: "medium" }, { supabase });

  const { recommendations } = await getRevisionRecommendations(studentId, { subject: "Data Structures" }, { supabase });
  const prereqIndex = recommendations.findIndex((r) => r.conceptKey === prereq.conceptKey);
  const targetIndex = recommendations.findIndex((r) => r.conceptKey === target.conceptKey);
  assert.ok(prereqIndex !== -1, "the zero-evidence blocker must still be surfaced");
  assert.ok(targetIndex !== -1);
  assert.ok(prereqIndex < targetIndex, "the prerequisite must rank strictly before the concept it blocks");
  const prereqEntry = recommendations[prereqIndex];
  assert.ok(prereqEntry.reasonCodes.includes("PREREQUISITE_BLOCKER"));
  // Week 4 hardening (Progress -> Intervention consistency fix): a substituted blocker row's
  // recovery target is the ORIGINAL blocked concept, not the blocker's own identity -- detect.ts's
  // PREREQUISITE_GAP trigger is only meaningful when evaluated on the blocked target.
  assert.equal(prereqEntry.interventionConceptKey, target.conceptKey);
  const targetEntry = recommendations[targetIndex];
  assert.equal(targetEntry.interventionConceptKey, target.conceptKey, "an ordinary (non-substituted) row's recovery target is itself");
});

test("Step 23 (mandatory): bounded output respects the configured limit, never returns every concept", async () => {
  const { supabase, studentId } = await setup();
  for (let i = 0; i < 8; i++) {
    const { concept } = await createOrResolveConcept({ subject: "Bounded Subject", displayName: `Concept ${i}` }, { supabase });
    await recordScoredOutcomeWithRetention({ studentId, conceptId: concept.id, outcome: "incorrect", difficulty: "medium" }, { supabase });
  }
  const { recommendations } = await getRevisionRecommendations(studentId, { subject: "Bounded Subject", limit: 3 }, { supabase });
  assert.equal(recommendations.length, 3);
});

test("a concept with zero evidence is never in the primary ranked list on its own (only ever surfaced as someone else's PREREQUISITE_BLOCKER)", async () => {
  const { supabase, studentId } = await setup();
  await createOrResolveConcept({ subject: "Unassessed Subject", displayName: "Untouched Concept" }, { supabase });
  const { recommendations } = await getRevisionRecommendations(studentId, { subject: "Unassessed Subject" }, { supabase });
  assert.equal(recommendations.length, 0);
});

test("Step 15/34: mastered but transfer-not-demonstrated concepts appear in the SEPARATE transferPractice list, never blended into the main §23-scored list", async () => {
  const { supabase, studentId } = await setup();
  const { concept } = await createOrResolveConcept({ subject: "Transfer Subject", displayName: "Mastered Concept" }, { supabase });
  for (let i = 0; i < 6; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId: concept.id, outcome: "correct", difficulty: "medium" }, { supabase });

  const { recommendations, transferPractice } = await getRevisionRecommendations(studentId, { subject: "Transfer Subject" }, { supabase });
  assert.ok(transferPractice.some((r) => r.conceptKey === concept.conceptKey));
  assert.ok(transferPractice.find((r) => r.conceptKey === concept.conceptKey)!.reasonCodes.includes("TRANSFER_NOT_DEMONSTRATED"));
  // A fully-mastered concept naturally scores LOW on §23's own mastery-gap term -- it should not
  // dominate the primary ranked list purely because it also appears in transferPractice.
  const mainEntry = recommendations.find((r) => r.conceptKey === concept.conceptKey);
  if (mainEntry) assert.ok(!mainEntry.reasonCodes.includes("TRANSFER_NOT_DEMONSTRATED"));
});

test("active misconception raises priority and adds ACTIVE_MISCONCEPTION; a candidate-only misconception does not (§14)", async () => {
  const { supabase, studentId } = await setup();
  const { concept } = await createOrResolveConcept({ subject: "Misconception Subject", displayName: "Concept" }, { supabase });
  await recordScoredOutcomeWithRetention({ studentId, conceptId: concept.id, outcome: "correct", difficulty: "medium" }, { supabase });

  const quizEvent = await recordLearningEvent({ studentId, conceptId: concept.id, eventType: "QUIZ_ANSWERED", metadata: { correct: false } }, { supabase });
  const observedEvent = await recordLearningEvent({ studentId, conceptId: concept.id, eventType: "MISCONCEPTION_OBSERVED", metadata: { proposedByLlm: true, relatedEventId: quizEvent.id, tag: "t" } }, { supabase });
  await recordMisconceptionEvidence({ studentId, conceptId: concept.id, sourceEventId: observedEvent.id, tag: "t", description: "d" }, { supabase }); // ONE observation -> stays 'candidate'

  const before = await getRevisionRecommendations(studentId, { subject: "Misconception Subject" }, { supabase });
  assert.ok(!before.recommendations.find((r) => r.conceptKey === concept.conceptKey)?.reasonCodes.includes("ACTIVE_MISCONCEPTION"));

  const quizEvent2 = await recordLearningEvent({ studentId, conceptId: concept.id, eventType: "QUIZ_ANSWERED", metadata: { correct: false } }, { supabase });
  const observedEvent2 = await recordLearningEvent({ studentId, conceptId: concept.id, eventType: "MISCONCEPTION_OBSERVED", metadata: { proposedByLlm: true, relatedEventId: quizEvent2.id, tag: "t" } }, { supabase });
  await recordMisconceptionEvidence({ studentId, conceptId: concept.id, sourceEventId: observedEvent2.id, tag: "t", description: "d" }, { supabase }); // second -> 'active'

  const after = await getRevisionRecommendations(studentId, { subject: "Misconception Subject" }, { supabase });
  assert.ok(after.recommendations.find((r) => r.conceptKey === concept.conceptKey)?.reasonCodes.includes("ACTIVE_MISCONCEPTION"));
});

// --- Determinism & side effects (Steps 53/54, mandatory) --------------------------------------------

test("determinism: same DB state + same injected now produces identical recommendations, called twice", async () => {
  const { supabase, studentId } = await setup();
  const { concept } = await createOrResolveConcept({ subject: "Determinism Subject", displayName: "Concept" }, { supabase });
  await recordScoredOutcomeWithRetention({ studentId, conceptId: concept.id, outcome: "incorrect", difficulty: "medium" }, { supabase });
  const now = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // safely after any real timestamp the fake DB just wrote
  const first = await getRevisionRecommendations(studentId, { subject: "Determinism Subject" }, { supabase, now });
  const second = await getRevisionRecommendations(studentId, { subject: "Determinism Subject" }, { supabase, now });
  assert.deepEqual(first, second);
});

// --- Step 51: revision-order conflicts ---------------------------------------------------------

test("conflict: an active misconception outranks an ordinary developing concept at similar mastery", async () => {
  const { supabase, studentId } = await setup();
  const { concept: plain } = await createOrResolveConcept({ subject: "Conflict Subject", displayName: "Plain" }, { supabase });
  const { concept: misconceptual } = await createOrResolveConcept({ subject: "Conflict Subject", displayName: "Misconceptual" }, { supabase });
  for (const c of [plain, misconceptual]) await recordScoredOutcomeWithRetention({ studentId, conceptId: c.id, outcome: "incorrect", difficulty: "medium" }, { supabase });
  for (let i = 0; i < 2; i++) {
    const quizEvent = await recordLearningEvent({ studentId, conceptId: misconceptual.id, eventType: "QUIZ_ANSWERED", metadata: { correct: false } }, { supabase });
    const observed = await recordLearningEvent({ studentId, conceptId: misconceptual.id, eventType: "MISCONCEPTION_OBSERVED", metadata: { proposedByLlm: true, relatedEventId: quizEvent.id, tag: "t" } }, { supabase });
    await recordMisconceptionEvidence({ studentId, conceptId: misconceptual.id, sourceEventId: observed.id, tag: "t", description: "d" }, { supabase });
  }
  const { recommendations } = await getRevisionRecommendations(studentId, { subject: "Conflict Subject" }, { supabase });
  const misconceptualIndex = recommendations.findIndex((r) => r.conceptKey === misconceptual.conceptKey);
  const plainIndex = recommendations.findIndex((r) => r.conceptKey === plain.conceptKey);
  assert.ok(misconceptualIndex < plainIndex, "an active misconception must outrank an otherwise-similar ordinary weak concept");
});

test("conflict: a NEW (zero-evidence) concept never appears in the ranked list ahead of a demonstrated weak concept -- it never appears at all", async () => {
  const { supabase, studentId } = await setup();
  const { concept: weak } = await createOrResolveConcept({ subject: "Conflict Subject 2", displayName: "Weak" }, { supabase });
  await createOrResolveConcept({ subject: "Conflict Subject 2", displayName: "Untouched" }, { supabase });
  await recordScoredOutcomeWithRetention({ studentId, conceptId: weak.id, outcome: "incorrect", difficulty: "medium" }, { supabase });
  const { recommendations } = await getRevisionRecommendations(studentId, { subject: "Conflict Subject 2" }, { supabase });
  assert.deepEqual(recommendations.map((r) => r.conceptKey), [weak.conceptKey]);
});

test("side-effect-free: repeated calls create zero new learning_events, transitions, or evidence rows", async () => {
  const { supabase, fake, studentId } = await setup();
  const { concept } = await createOrResolveConcept({ subject: "SideEffect Subject", displayName: "Concept" }, { supabase });
  await recordScoredOutcomeWithRetention({ studentId, conceptId: concept.id, outcome: "incorrect", difficulty: "medium" }, { supabase });

  const before = {
    events: fake.tables.events.rows.length,
    transitions: fake.tables.transitions.rows.length,
    misconceptions: fake.tables.misconceptions.rows.length,
    transferEvidence: fake.tables.transferEvidence.rows.length,
  };
  await getRevisionRecommendations(studentId, { subject: "SideEffect Subject" }, { supabase });
  await getRevisionRecommendations(studentId, { subject: "SideEffect Subject" }, { supabase });
  assert.equal(fake.tables.events.rows.length, before.events);
  assert.equal(fake.tables.transitions.rows.length, before.transitions);
  assert.equal(fake.tables.misconceptions.rows.length, before.misconceptions);
  assert.equal(fake.tables.transferEvidence.rows.length, before.transferEvidence);
});
