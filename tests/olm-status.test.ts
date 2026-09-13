import assert from "node:assert/strict";
import test from "node:test";
import { explainConceptStatus, getConceptStatus } from "@/lib/learning/olm";
import { createFakeLearningSupabase } from "./support/fake-learning-db";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { createOrResolveConcept, addPrerequisite } from "@/lib/learning/concepts";
import { recordScoredOutcomeWithRetention } from "@/lib/learning/reviews";
import { recordLearningEvent } from "@/lib/learning/events";
import { recordMisconceptionEvidence } from "@/lib/learning/misconceptions";
import { applyTransferEvidence } from "@/lib/learning/transfer";

// --- §30.3 explainConceptStatus, pure ---------------------------------------------------------

function baseInput(overrides: Partial<Parameters<typeof explainConceptStatus>[0]> = {}) {
  return { stage: "DEVELOPING" as const, evidenceCount: 3, activeMisconception: null, retentionUrgencyLevel: null, transferReadiness: null, ...overrides };
}

test("NEW stage: exactly one bullet, 'Not yet studied', regardless of any other field", () => {
  assert.deepEqual(explainConceptStatus(baseInput({ stage: "NEW", evidenceCount: 0, activeMisconception: { description: "x", evidenceCount: 9 } })), ["Not yet studied"]);
});

test("reproduces the architecture's own worked example verbatim: Rabin-Karp -- Developing", () => {
  const bullets = explainConceptStatus({ stage: "DEVELOPING", evidenceCount: 3, activeMisconception: { description: "rolling hash", evidenceCount: 2 }, retentionUrgencyLevel: "warning", transferReadiness: null });
  assert.deepEqual(bullets, ["3 practice attempts", "2 recent errors involving rolling hash", "Review recommended -- retention has dropped since last practiced"]);
});

test("misconception bullet only appears for an ACTIVE misconception (caller-gated -- this function trusts its input)", () => {
  assert.deepEqual(explainConceptStatus(baseInput({ activeMisconception: null })), ["3 practice attempts"]);
});

test("'Review recommended' fires on retention urgency WARNING/CRITICAL, independent of stage label", () => {
  assert.ok(explainConceptStatus(baseInput({ retentionUrgencyLevel: "warning" })).some((l) => l.startsWith("Review recommended")));
  assert.ok(explainConceptStatus(baseInput({ retentionUrgencyLevel: "critical" })).some((l) => l.startsWith("Review recommended")));
  assert.ok(!explainConceptStatus(baseInput({ retentionUrgencyLevel: "ok" })).some((l) => l.startsWith("Review recommended")));
  assert.ok(!explainConceptStatus(baseInput({ retentionUrgencyLevel: null })).some((l) => l.startsWith("Review recommended")));
});

test("transfer bullet only for 'ready', never for 'attempted'/'not_attempted'/null", () => {
  assert.ok(explainConceptStatus(baseInput({ transferReadiness: "ready" })).some((l) => l.includes("Successfully applied")));
  assert.ok(!explainConceptStatus(baseInput({ transferReadiness: "attempted" })).some((l) => l.includes("Successfully applied")));
  assert.ok(!explainConceptStatus(baseInput({ transferReadiness: "not_attempted" })).some((l) => l.includes("Successfully applied")));
  assert.ok(!explainConceptStatus(baseInput({ transferReadiness: null })).some((l) => l.includes("Successfully applied")));
});

test("never more than 3 bullets (§30.3: '1-3 short factual bullet lines')", () => {
  const bullets = explainConceptStatus({ stage: "MASTERED", evidenceCount: 10, activeMisconception: { description: "x", evidenceCount: 3 }, retentionUrgencyLevel: "critical", transferReadiness: "ready" });
  assert.ok(bullets.length <= 3);
});

// --- getConceptStatus, DB-backed -----------------------------------------------------------------

async function setup(subject = "Data Structures", displayName = "Binary Search") {
  const fake = createFakeLearningSupabase();
  const supabase = fake as never;
  const profile = await getOrCreateDefaultProfile({ supabase });
  const { concept } = await createOrResolveConcept({ subject, displayName }, { supabase });
  return { supabase, fake, studentId: profile.id, conceptId: concept.id, conceptKey: concept.conceptKey };
}

test("Step 44/46: a concept with zero evidence is NEW, never classified as weak", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const status = await getConceptStatus(studentId, conceptId, { supabase });
  assert.equal(status.stage, "NEW");
  assert.equal(status.evidenceCount, 0);
  assert.deepEqual(status.why, ["Not yet studied"]);
});

test("Step 45 (mandatory): high mastery + due FSRS -> REVIEW_DUE, and BKT mastery is untouched", async () => {
  const { supabase, studentId, conceptId } = await setup();
  for (let i = 0; i < 5; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId, outcome: "correct", difficulty: "medium" }, { supabase });
  const before = await getConceptStatus(studentId, conceptId, { supabase });
  assert.equal(before.stage, "MASTERED");

  const farFuture = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);
  const after = await getConceptStatus(studentId, conceptId, { supabase, now: farFuture });
  assert.equal(after.stage, "REVIEW_DUE");
  // Re-reading mastery directly confirms the underlying BKT value itself was never touched by this read-only call.
  const { getMasteryState } = await import("@/lib/learning/mastery");
  const mastery = await getMasteryState(studentId, conceptId, { supabase } as never);
  assert.ok(mastery!.pMastery! >= 0.85, "BKT mastery must remain unchanged by a read-only status check");
});

test("Step 48: transfer visibility -- 0 attempts means no claim; >=1 attempt makes it visible", async () => {
  const { supabase, studentId, conceptId } = await setup();
  await recordScoredOutcomeWithRetention({ studentId, conceptId, outcome: "correct", difficulty: "medium" }, { supabase });
  const zeroAttempts = await getConceptStatus(studentId, conceptId, { supabase });
  assert.equal(zeroAttempts.transferReadiness, null);

  const event = await recordLearningEvent({ studentId, conceptId, eventType: "TRANSFER_ATTEMPTED", metadata: { dimension: "transfer", score: 0.2 } }, { supabase });
  await applyTransferEvidence({ studentId, conceptId, level: "transfer", score: 0.2, sourceEventId: event.id }, { supabase });
  const oneAttempt = await getConceptStatus(studentId, conceptId, { supabase });
  assert.notEqual(oneAttempt.transferReadiness, null);
});

test("Step 50: candidate misconception is invisible; active is visible", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const quizEvent = await recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED", metadata: { correct: false } }, { supabase });
  const observed = await recordLearningEvent({ studentId, conceptId, eventType: "MISCONCEPTION_OBSERVED", metadata: { proposedByLlm: true, relatedEventId: quizEvent.id, tag: "t" } }, { supabase });
  await recordMisconceptionEvidence({ studentId, conceptId, sourceEventId: observed.id, tag: "t", description: "confuses the base case" }, { supabase });
  const candidateOnly = await getConceptStatus(studentId, conceptId, { supabase });
  assert.equal(candidateOnly.activeMisconception, null);

  const quizEvent2 = await recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED", metadata: { correct: false } }, { supabase });
  const observed2 = await recordLearningEvent({ studentId, conceptId, eventType: "MISCONCEPTION_OBSERVED", metadata: { proposedByLlm: true, relatedEventId: quizEvent2.id, tag: "t" } }, { supabase });
  await recordMisconceptionEvidence({ studentId, conceptId, sourceEventId: observed2.id, tag: "t", description: "confuses the base case" }, { supabase });
  const active = await getConceptStatus(studentId, conceptId, { supabase });
  assert.ok(active.activeMisconception);
  assert.equal(active.activeMisconception!.tag, "t");
});

test("Step 47: strong-area criteria -- insufficient evidence cannot be MASTERED even with a lucky high mastery number", async () => {
  const { supabase, studentId, conceptId } = await setup();
  await recordScoredOutcomeWithRetention({ studentId, conceptId, outcome: "correct", difficulty: "medium" }, { supabase }); // only 1 opportunity
  const status = await getConceptStatus(studentId, conceptId, { supabase });
  assert.notEqual(status.stage, "MASTERED");
});

test("side-effect-free: repeated getConceptStatus calls never mutate learner state", async () => {
  const { supabase, fake, studentId, conceptId } = await setup();
  await recordScoredOutcomeWithRetention({ studentId, conceptId, outcome: "correct", difficulty: "medium" }, { supabase });
  const before = { transitions: fake.tables.transitions.rows.length, events: fake.tables.events.rows.length };
  await getConceptStatus(studentId, conceptId, { supabase });
  await getConceptStatus(studentId, conceptId, { supabase });
  assert.equal(fake.tables.transitions.rows.length, before.transitions);
  assert.equal(fake.tables.events.rows.length, before.events);
});

test("prerequisite-blocked concept's status is still reportable on its own terms (readiness is a separate axis from OLM stage)", async () => {
  const { supabase, studentId } = await setup();
  const { concept: prereq } = await createOrResolveConcept({ subject: "Data Structures", displayName: "Arrays" }, { supabase });
  const { concept: target } = await createOrResolveConcept({ subject: "Data Structures", displayName: "Binary Search 2" }, { supabase });
  await addPrerequisite(target.id, prereq.id, { supabase });
  const status = await getConceptStatus(studentId, target.id, { supabase });
  assert.equal(status.stage, "NEW"); // no evidence yet -- readiness blocking doesn't fabricate a different stage
});
