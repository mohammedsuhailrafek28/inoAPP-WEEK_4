import assert from "node:assert/strict";
import test from "node:test";
import { createFakeLearningSupabase } from "./support/fake-learning-db";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { createOrResolveConcept } from "@/lib/learning/concepts";
import { generateNotesForConcept, generateFlashcardsForConcept, MaterialValidationError } from "@/lib/materials/service";
import { listAgentActivity } from "@/lib/learning/agent-activity";
import type { RetrievalMatch } from "@/lib/documents/retrieval";

async function setup(subject = "Machine Learning", displayName = "Linear Regression") {
  const fake = createFakeLearningSupabase();
  const supabase = fake as never;
  const profile = await getOrCreateDefaultProfile({ supabase });
  const { concept } = await createOrResolveConcept({ subject, displayName }, { supabase });
  return { supabase, fake, studentId: profile.id, conceptId: concept.id, conceptKey: concept.conceptKey, subject };
}

function fakeMatch(overrides: Partial<RetrievalMatch> = {}): RetrievalMatch {
  return { chunkId: "chunk-1", documentId: "doc-1", filename: "notes.pdf", pageNumber: 1, ordinalOnPage: 1, text: "Linear regression fits a line minimizing squared error.", similarity: 0.9, ...overrides };
}

const SUFFICIENT_RETRIEVE = async () => ({ status: "sufficient" as const, matches: [fakeMatch()] });
const INSUFFICIENT_RETRIEVE = async () => ({ status: "insufficient" as const, matches: [] });

function notesCandidateJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: "Linear Regression Essentials",
    summary: "Linear regression fits a line to data by minimizing squared error.",
    keyPoints: ["Minimizes squared error", "Assumes a linear relationship"],
    importantTerms: [{ term: "Residual", definition: "Gap between observed and predicted values." }],
    examFocus: ["Cost function derivation"],
    sourceLabels: ["S1"],
    ...overrides,
  });
}

function flashcardsCandidateJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    cards: [
      { front: "What does linear regression minimize?", back: "Squared error.", sourceLabels: ["S1"] },
      { front: "What is a residual?", back: "The gap between observed and predicted values.", sourceLabels: ["S1"] },
      { front: "What relationship does linear regression assume?", back: "A linear one.", sourceLabels: ["S1"] },
    ],
    ...overrides,
  });
}

// --- Notes ---------------------------------------------------------------------------------------

test("notes: grounded output is accepted and produces a client-shaped result with citations", async () => {
  const { supabase, studentId, conceptKey } = await setup();
  const result = await generateNotesForConcept(studentId, { conceptKey, documentIds: ["doc-1"] }, { supabase, retrieve: SUFFICIENT_RETRIEVE, generate: async () => notesCandidateJson() });
  assert.equal(result.status, "generated");
  if (result.status !== "generated") return;
  assert.equal(result.notes.conceptKey, conceptKey);
  assert.equal(result.notes.title, "Linear Regression Essentials");
  assert.equal(result.notes.citations.length, 1);
  assert.equal(result.notes.citations[0].chunkId, "chunk-1");
});

test("notes: an unsupported/unknown citation label is rejected", async () => {
  const { supabase, studentId, conceptKey } = await setup();
  const result = await generateNotesForConcept(studentId, { conceptKey, documentIds: ["doc-1"] }, { supabase, retrieve: SUFFICIENT_RETRIEVE, generate: async () => notesCandidateJson({ sourceLabels: ["S99"] }) });
  assert.equal(result.status, "generation_failed");
  if (result.status === "generation_failed") assert.match(result.reason, /MISSING_SOURCE_SUPPORT/);
});

test("notes: malformed Gemini output is rejected safely, never thrown", async () => {
  const { supabase, studentId, conceptKey } = await setup();
  const result = await generateNotesForConcept(studentId, { conceptKey, documentIds: ["doc-1"] }, { supabase, retrieve: SUFFICIENT_RETRIEVE, generate: async () => "not json at all" });
  assert.equal(result.status, "generation_failed");
  if (result.status === "generation_failed") assert.match(result.reason, /MALFORMED_OUTPUT/);
});

test("notes: no retrieval context is handled safely as insufficient_evidence, with zero Gemini calls", async () => {
  const { supabase, studentId, conceptKey } = await setup();
  let generateCalls = 0;
  const result = await generateNotesForConcept(
    studentId,
    { conceptKey, documentIds: ["doc-1"] },
    { supabase, retrieve: INSUFFICIENT_RETRIEVE, generate: async () => { generateCalls += 1; return notesCandidateJson(); } },
  );
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(generateCalls, 0);
});

test("notes: a retrieval failure (e.g. a stale/unready document id) returns a structured generation_failed result, never an unhandled throw", async () => {
  const { supabase, studentId, conceptKey } = await setup();
  const result = await generateNotesForConcept(
    studentId,
    { conceptKey, documentIds: ["doc-1"] },
    { supabase, retrieve: async () => { throw new Error("Selected documents must exist and be ready."); } },
  );
  assert.equal(result.status, "generation_failed");
  if (result.status === "generation_failed") assert.match(result.reason, /must exist and be ready/);
});

test("notes: unknown conceptKey is a validation error, never an unhandled throw shape", async () => {
  const { supabase, studentId } = await setup();
  await assert.rejects(() => generateNotesForConcept(studentId, { conceptKey: "does-not-exist", documentIds: ["doc-1"] }, { supabase, retrieve: SUFFICIENT_RETRIEVE }), MaterialValidationError);
});

test("notes: a successful generation logs exactly one MATERIAL_GENERATED activity row", async () => {
  const { supabase, studentId, conceptKey, conceptId, subject } = await setup();
  await generateNotesForConcept(studentId, { conceptKey, documentIds: ["doc-1"] }, { supabase, retrieve: SUFFICIENT_RETRIEVE, generate: async () => notesCandidateJson() });
  const activity = await listAgentActivity(studentId, { subject: subject.toLowerCase().replace(/\s+/g, "-") }, { supabase });
  assert.equal(activity.length, 1);
  assert.equal(activity[0].kind, "MATERIAL_GENERATED");
  assert.equal(activity[0].conceptId, conceptId);
  assert.equal(activity[0].metadata.materialType, "notes");
});

test("notes: a rejected/failed generation logs nothing", async () => {
  const { supabase, studentId, conceptKey, subject } = await setup();
  await generateNotesForConcept(studentId, { conceptKey, documentIds: ["doc-1"] }, { supabase, retrieve: SUFFICIENT_RETRIEVE, generate: async () => "not json at all" });
  const activity = await listAgentActivity(studentId, { subject: subject.toLowerCase().replace(/\s+/g, "-") }, { supabase });
  assert.equal(activity.length, 0);
});

// --- Flashcards ------------------------------------------------------------------------------

test("flashcards: valid grounded cards are accepted and bounded", async () => {
  const { supabase, studentId, conceptKey } = await setup();
  const result = await generateFlashcardsForConcept(studentId, { conceptKey, documentIds: ["doc-1"] }, { supabase, retrieve: SUFFICIENT_RETRIEVE, generate: async () => flashcardsCandidateJson() });
  assert.equal(result.status, "generated");
  if (result.status !== "generated") return;
  assert.equal(result.flashcards.cards.length, 3);
  assert.ok(result.flashcards.cards.every((c) => c.citations.length > 0));
});

test("flashcards: malformed JSON is rejected safely", async () => {
  const { supabase, studentId, conceptKey } = await setup();
  const result = await generateFlashcardsForConcept(studentId, { conceptKey, documentIds: ["doc-1"] }, { supabase, retrieve: SUFFICIENT_RETRIEVE, generate: async () => "not json at all" });
  assert.equal(result.status, "generation_failed");
  if (result.status === "generation_failed") assert.match(result.reason, /MALFORMED_OUTPUT/);
});

test("flashcards: too few grounded cards survive filtering to be a useful set", async () => {
  const { supabase, studentId, conceptKey } = await setup();
  const result = await generateFlashcardsForConcept(
    studentId,
    { conceptKey, documentIds: ["doc-1"] },
    { supabase, retrieve: SUFFICIENT_RETRIEVE, generate: async () => flashcardsCandidateJson({ cards: [{ front: "Only one card", back: "One answer", sourceLabels: ["S1"] }] }) },
  );
  assert.equal(result.status, "generation_failed");
  if (result.status === "generation_failed") assert.match(result.reason, /INSUFFICIENT_GROUNDED_CARDS/);
});

test("flashcards: no retrieval context is handled safely, zero Gemini calls", async () => {
  const { supabase, studentId, conceptKey } = await setup();
  let generateCalls = 0;
  const result = await generateFlashcardsForConcept(
    studentId,
    { conceptKey, documentIds: ["doc-1"] },
    { supabase, retrieve: INSUFFICIENT_RETRIEVE, generate: async () => { generateCalls += 1; return flashcardsCandidateJson(); } },
  );
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(generateCalls, 0);
});

test("flashcards: a successful generation logs exactly one MATERIAL_GENERATED activity row", async () => {
  const { supabase, studentId, conceptKey, subject } = await setup();
  await generateFlashcardsForConcept(studentId, { conceptKey, documentIds: ["doc-1"] }, { supabase, retrieve: SUFFICIENT_RETRIEVE, generate: async () => flashcardsCandidateJson() });
  const activity = await listAgentActivity(studentId, { subject: subject.toLowerCase().replace(/\s+/g, "-") }, { supabase });
  assert.equal(activity.length, 1);
  assert.equal(activity[0].kind, "MATERIAL_GENERATED");
  assert.equal(activity[0].metadata.materialType, "flashcards");
  assert.equal(activity[0].metadata.cardCount, 3);
});

test("request validation rejects an empty documentIds array before ever calling Gemini", async () => {
  const { supabase, studentId, conceptKey } = await setup();
  let generateCalls = 0;
  await assert.rejects(
    () => generateNotesForConcept(studentId, { conceptKey, documentIds: [] }, { supabase, retrieve: SUFFICIENT_RETRIEVE, generate: async () => { generateCalls += 1; return notesCandidateJson(); } }),
    MaterialValidationError,
  );
  assert.equal(generateCalls, 0);
});
