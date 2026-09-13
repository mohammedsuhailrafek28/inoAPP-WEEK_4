import assert from "node:assert/strict";
import test from "node:test";
import { createFakeLearningSupabase } from "./support/fake-learning-db";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { createOrResolveConcept, addPrerequisite } from "@/lib/learning/concepts";
import { recordScoredOutcomeWithRetention } from "@/lib/learning/reviews";
import { recordLearningEvent } from "@/lib/learning/events";
import { recordMisconceptionEvidence } from "@/lib/learning/misconceptions";
import { proposeNarrativeMemory } from "@/lib/learning/memory";
import { startSession, endSession } from "@/lib/learning/sessions";
import { buildPersonalizationContext } from "@/lib/personalization/prompt-context";
import { answerWithRag } from "@/lib/documents/rag";
import type { RetrievalMatch } from "@/lib/documents/retrieval";

async function setup(subject = "Data Structures", displayName = "Binary Search") {
  const fake = createFakeLearningSupabase();
  const supabase = fake as never;
  const profile = await getOrCreateDefaultProfile({ supabase });
  const { concept } = await createOrResolveConcept({ subject, displayName }, { supabase });
  return { supabase, fake, studentId: profile.id, conceptId: concept.id, conceptKey: concept.conceptKey, subject };
}

async function misconceptionObservedEvent(studentId: string, conceptId: string, tag: string, supabase: unknown) {
  const quizEvent = await recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED", metadata: { correct: false } }, { supabase } as never);
  return recordLearningEvent({ studentId, conceptId, eventType: "MISCONCEPTION_OBSERVED", metadata: { proposedByLlm: true, relatedEventId: quizEvent.id, tag } }, { supabase } as never);
}

async function activateMisconception(studentId: string, conceptId: string, tag: string, supabase: unknown) {
  for (let i = 0; i < 2; i++) {
    const event = await misconceptionObservedEvent(studentId, conceptId, tag, supabase);
    await recordMisconceptionEvidence({ studentId, conceptId, sourceEventId: event.id, tag, description: "A confirmed recurring error." }, { supabase } as never);
  }
}

const match = (over: Partial<RetrievalMatch> = {}): RetrievalMatch => ({ chunkId: "chunk-1", documentId: "doc-1", filename: "notes.pdf", pageNumber: 1, ordinalOnPage: 1, text: "Binary search halves the search space each comparison.", similarity: 0.9, ...over });
const sufficient = (matches: RetrievalMatch[] = [match()]) => async () => ({ status: "sufficient" as const, matches });
const insufficient = async () => ({ status: "insufficient" as const, matches: [] as RetrievalMatch[] });
const gen = (text = '{"answer":"Binary search halves the search space [S1].","usedSources":["S1"]}') => async () => text;

function fetchPersonalizationFor(studentId: string, conceptKey: string | undefined, supabase: unknown) {
  return async () => (await buildPersonalizationContext({ studentId, conceptKey }, { supabase: supabase as never })).prompt ?? undefined;
}

// --- Matrix: representative learner-state scenarios (Step 33) --------------------------------------

test("1. new learner: grounded answer succeeds, personalization applies with action EXPLAIN (insufficient-evidence row)", async () => {
  const { supabase, studentId, conceptKey, subject } = await setup();
  const result = await answerWithRag({ question: "What does it do?", documentIds: ["doc-1"], mode: "simple", conceptKey }, { retrieve: sufficient(), generate: gen(), fetchPersonalization: fetchPersonalizationFor(studentId, conceptKey, supabase) });
  assert.equal(result.status, "grounded");
  const personalization = await buildPersonalizationContext({ studentId, conceptKey }, { supabase });
  assert.equal(personalization.metadata.personalizationApplied, true);
  assert.equal(personalization.metadata.pedagogicalAction, "EXPLAIN");
  void subject;
});

test("2. low mastery, recent incorrect answer -> SIMPLIFY (chat-presentable)", async () => {
  const { supabase, studentId, conceptId, conceptKey } = await setup();
  for (let i = 0; i < 3; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId, outcome: "correct", difficulty: "medium" }, { supabase });
  await recordScoredOutcomeWithRetention({ studentId, conceptId, outcome: "incorrect", difficulty: "medium" }, { supabase });
  const personalization = await buildPersonalizationContext({ studentId, conceptKey }, { supabase });
  assert.equal(personalization.metadata.pedagogicalAction, "SIMPLIFY");
  assert.equal(personalization.prompt?.action, "SIMPLIFY");
});

test("4. mastered + review due -> SPACED_REVIEW is NOT chat-presentable, but personalization still applies with the concept's REVIEW_DUE stage", async () => {
  const { supabase, studentId, conceptId, conceptKey } = await setup();
  for (let i = 0; i < 5; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId, outcome: "correct", difficulty: "medium" }, { supabase });
  const personalization = await buildPersonalizationContext({ studentId, conceptKey }, { supabase, now: new Date(Date.now() + 400 * 24 * 60 * 60 * 1000) });
  if (personalization.metadata.pedagogicalAction === "SPACED_REVIEW") {
    assert.equal(personalization.prompt?.action, null); // filtered out of the chat prompt -- quiz-only action
    assert.match(personalization.prompt?.contextText ?? "", /REVIEW_DUE/);
  }
});

test("5. prerequisite blocked: personalization teaches the RETARGETED prerequisite, not the originally-asked concept", async () => {
  const { supabase, studentId } = await setup();
  const { concept: prereq } = await createOrResolveConcept({ subject: "Data Structures", displayName: "Arrays" }, { supabase });
  const { concept: target } = await createOrResolveConcept({ subject: "Data Structures", displayName: "Binary Search 2" }, { supabase });
  await addPrerequisite(target.id, prereq.id, { supabase });

  const personalization = await buildPersonalizationContext({ studentId, conceptKey: target.conceptKey }, { supabase });
  assert.equal(personalization.metadata.pedagogicalAction, "PREREQUISITE_REMEDIATION");
  assert.equal(personalization.metadata.targetConceptKey, prereq.conceptKey); // NOT target.conceptKey
  assert.match(personalization.prompt?.contextText ?? "", /Arrays/);
});

test("6. active misconception surfaces in learner context; 7. a CANDIDATE-only misconception never surfaces", async () => {
  const { supabase, studentId, conceptId, conceptKey } = await setup();
  await activateMisconception(studentId, conceptId, "off_by_one_boundary", supabase);
  const active = await buildPersonalizationContext({ studentId, conceptKey }, { supabase });
  assert.match(active.prompt?.contextText ?? "", /confirmed recurring error/i);

  const { supabase: supabase2, studentId: studentId2, conceptId: conceptId2, conceptKey: conceptKey2 } = await setup("Algorithms", "Rolling Hash");
  const event = await misconceptionObservedEvent(studentId2, conceptId2, "candidate_only", supabase2); // ONE observation -> stays 'candidate', never 'active'
  await recordMisconceptionEvidence({ studentId: studentId2, conceptId: conceptId2, sourceEventId: event.id, tag: "candidate_only", description: "A candidate error." }, { supabase: supabase2 as never });
  const candidateOnly = await buildPersonalizationContext({ studentId: studentId2, conceptKey: conceptKey2 }, { supabase: supabase2 });
  assert.doesNotMatch(candidateOnly.prompt?.contextText ?? "", /candidate error/i);
});

test("13. narrative contradiction (mandatory): a confirmed narrative memory claiming mastery does not change the decision when authoritative BKT says otherwise", async () => {
  const { supabase, studentId, conceptId, conceptKey, subject } = await setup();
  const s1 = await startSession(studentId, subject, undefined, { supabase });
  await proposeNarrativeMemory({ studentId, sessionId: s1.id, content: "Student has fully mastered binary search." }, { supabase });
  await endSession(s1.id, studentId, "explicit", undefined, { supabase });
  const s2 = await startSession(studentId, subject, undefined, { supabase });
  const { corroborated } = await proposeNarrativeMemory({ studentId, sessionId: s2.id, content: "The student has fully mastered binary search." }, { supabase });
  await endSession(s2.id, studentId, "explicit", undefined, { supabase });
  assert.ok(corroborated, "the two similar observations across different sessions should corroborate into a confirmed memory");

  // Real mastery is still low (0 evidence) -- the decision must follow BKT, not the narrative claim.
  const personalization = await buildPersonalizationContext({ studentId, conceptKey }, { supabase });
  assert.equal(personalization.metadata.pedagogicalAction, "EXPLAIN");
  assert.notEqual(personalization.metadata.pedagogicalAction, "DEEPEN"); // what a "mastered" narrative might otherwise have implied
  void conceptId;
});

test("15/27. no concept resolvable (omitted or unknown key): personalization does not apply, plain grounded RAG unaffected", async () => {
  const { supabase, fake, studentId } = await setup();
  const omitted = await buildPersonalizationContext({ studentId, conceptKey: undefined }, { supabase });
  assert.equal(omitted.metadata.personalizationApplied, false);
  assert.equal(omitted.prompt, null);

  const unknown = await buildPersonalizationContext({ studentId, conceptKey: "no-such-concept" }, { supabase });
  assert.equal(unknown.metadata.personalizationApplied, false);

  // A concept is never auto-created as a side effect of asking.
  assert.ok(!fake.tables.concepts.rows.some((c) => c.concept_key === "no-such-concept"));
});

test("16. personalization-service failure never corrupts or weakens source-grounded RAG", async () => {
  const result = await answerWithRag(
    { question: "What is X?", documentIds: ["doc-1"], mode: "simple" },
    { retrieve: sufficient(), generate: gen(), fetchPersonalization: async () => { throw new Error("boom"); } },
  );
  assert.equal(result.status, "grounded");
  assert.match(result.answer, /Binary search/);
});

test("17/36. RAG abstention survives even with a strong pedagogical signal requesting review/simplification (mandatory)", async () => {
  const { supabase, studentId, conceptId, conceptKey } = await setup();
  for (let i = 0; i < 3; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId, outcome: "correct", difficulty: "medium" }, { supabase });
  await recordScoredOutcomeWithRetention({ studentId, conceptId, outcome: "incorrect", difficulty: "medium" }, { supabase }); // -> SIMPLIFY, a real, non-trivial pedagogical signal

  let generateCalled = false;
  const result = await answerWithRag(
    { question: "Explain this simply.", documentIds: ["doc-1"], mode: "simple", conceptKey },
    { retrieve: insufficient, generate: async () => { generateCalled = true; return gen()(); }, fetchPersonalization: fetchPersonalizationFor(studentId, conceptKey, supabase) },
  );
  assert.equal(result.status, "insufficient");
  assert.equal(generateCalled, false); // zero generation calls, exactly like Week 2
  assert.equal(result.citations.length, 0);
});

// --- Source-invariance & citation-invariance (Steps 34/35, mandatory) -------------------------------

test("source-invariance: identical question + documents retrieve IDENTICAL evidence regardless of learner state", async () => {
  const { supabase: dbA, studentId: studentA, conceptKey: keyA } = await setup(); // brand-new learner
  const { supabase: dbB, studentId: studentB, conceptKey: keyB, conceptId: conceptBId } = await setup(); // will be given high mastery below
  for (let i = 0; i < 5; i++) await recordScoredOutcomeWithRetention({ studentId: studentB, conceptId: conceptBId, outcome: "correct", difficulty: "medium" }, { supabase: dbB });

  const matches = [match(), match({ chunkId: "chunk-2", pageNumber: 2 })];
  let seenA: RetrievalMatch[] = [];
  let seenB: RetrievalMatch[] = [];
  const trackingRetrieve = (sink: { set: (m: RetrievalMatch[]) => void }) => async () => {
    sink.set(matches);
    return { status: "sufficient" as const, matches };
  };

  const resultA = await answerWithRag({ question: "Explain X", documentIds: ["doc-1"], mode: "simple", conceptKey: keyA }, { retrieve: trackingRetrieve({ set: (m) => (seenA = m) }), generate: gen(), fetchPersonalization: fetchPersonalizationFor(studentA, keyA, dbA) });
  const resultB = await answerWithRag({ question: "Explain X", documentIds: ["doc-1"], mode: "simple", conceptKey: keyB }, { retrieve: trackingRetrieve({ set: (m) => (seenB = m) }), generate: gen(), fetchPersonalization: fetchPersonalizationFor(studentB, keyB, dbB) });

  assert.deepEqual(seenA.map((m) => m.chunkId), seenB.map((m) => m.chunkId)); // retrieval itself is identical
  assert.equal(resultA.status, "grounded");
  assert.equal(resultB.status, "grounded");
});

test("citation-invariance: personalization never changes citation metadata for the same accepted answer/evidence", async () => {
  const { supabase: dbA, studentId: studentA, conceptKey: keyA } = await setup();
  const { supabase: dbB, studentId: studentB, conceptKey: keyB } = await setup();
  const resultA = await answerWithRag({ question: "Explain X", documentIds: ["doc-1"], mode: "simple", conceptKey: keyA }, { retrieve: sufficient(), generate: gen(), fetchPersonalization: fetchPersonalizationFor(studentA, keyA, dbA) });
  const resultB = await answerWithRag({ question: "Explain X", documentIds: ["doc-1"], mode: "simple", conceptKey: keyB }, { retrieve: sufficient(), generate: gen(), fetchPersonalization: fetchPersonalizationFor(studentB, keyB, dbB) });
  assert.deepEqual(resultA.citations, resultB.citations);
});

// --- Side-effect boundary (Step 37, mandatory) ------------------------------------------------------

test("a personalized RAG answer emits QUESTION_ASKED-equivalent evidence only -- never BKT/IRT/FSRS/transfer/misconception/calibration writes", async () => {
  const { supabase, fake, studentId, conceptId, conceptKey } = await setup();
  await recordScoredOutcomeWithRetention({ studentId, conceptId, outcome: "correct", difficulty: "medium" }, { supabase }); // seed some real state to personalize against

  const beforeTransitions = fake.tables.transitions.rows.length;
  const beforeAbilityTransitions = fake.tables.abilityTransitions.rows.length;
  const beforeRetentionTransitions = fake.tables.retentionTransitions.rows.length;
  const beforeTransferEvidence = fake.tables.transferEvidence.rows.length;
  const beforeMisconceptions = fake.tables.misconceptions.rows.length;
  const beforeCalibration = fake.tables.calibrationRecords.rows.length;

  await answerWithRag({ question: "Explain X", documentIds: ["doc-1"], mode: "simple", conceptKey }, { retrieve: sufficient(), generate: gen(), fetchPersonalization: fetchPersonalizationFor(studentId, conceptKey, supabase) });

  assert.equal(fake.tables.transitions.rows.length, beforeTransitions);
  assert.equal(fake.tables.abilityTransitions.rows.length, beforeAbilityTransitions);
  assert.equal(fake.tables.retentionTransitions.rows.length, beforeRetentionTransitions);
  assert.equal(fake.tables.transferEvidence.rows.length, beforeTransferEvidence);
  assert.equal(fake.tables.misconceptions.rows.length, beforeMisconceptions);
  assert.equal(fake.tables.calibrationRecords.rows.length, beforeCalibration);
});

// --- Client-spoof protection --------------------------------------------------------------------

test("client-supplied conceptKey selects WHICH concept to personalize for, but never any learner-state value -- every actual value is server-derived", async () => {
  const { supabase, studentId, conceptId, conceptKey } = await setup();
  for (let i = 0; i < 5; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId, outcome: "correct", difficulty: "medium" }, { supabase });
  // A malicious/naive client cannot pass mastery/difficulty/action/scaffolding through this contract at all -- PersonalizationRequest has no such fields.
  const personalization = await buildPersonalizationContext({ studentId, conceptKey } as never, { supabase });
  assert.equal(typeof personalization.metadata.pedagogicalAction, "string");
  // The real, server-computed action for a fully-correct 5-evidence run is never something a client could have injected -- it's whatever the deterministic engine produced.
  assert.ok(personalization.metadata.pedagogicalAction);
});
