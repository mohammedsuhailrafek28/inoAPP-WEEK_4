import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { NarrativeMemoryValidationError, listNarrativeMemories, narrativeThemeSimilarity, proposeNarrativeMemory } from "@/lib/learning/memory";
import { startSession } from "@/lib/learning/sessions";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { createFakeLearningSupabase } from "./support/fake-learning-db";

async function setup() {
  const fake = createFakeLearningSupabase();
  const supabase = fake as never;
  const profile = await getOrCreateDefaultProfile({ supabase });
  return { supabase, fake, studentId: profile.id };
}

test("narrativeThemeSimilarity: normalized token overlap, pure, no embedding call", () => {
  assert.ok(narrativeThemeSimilarity("strong at recursion, weak at pointers", "consistently strong at recursion but weak with pointers") > 0.6);
  assert.ok(narrativeThemeSimilarity("strong at recursion", "struggles with binary search boundaries") < 0.3);
  assert.equal(narrativeThemeSimilarity("", "anything"), 0);
});

test("a lone candidate stays pending -- one LLM utterance is never authoritative (§5.1)", async () => {
  const { supabase, studentId } = await setup();
  const session = await startSession(studentId, "algorithms", undefined, { supabase });
  const result = await proposeNarrativeMemory({ studentId, sessionId: session.id, content: "Consistently strong at recursion." }, { supabase });
  assert.equal(result.memory.status, "pending");
  assert.equal(result.corroborated, null);
});

test("a second, similarly-themed candidate from a LATER session promotes the earlier one to confirmed", async () => {
  const { supabase, studentId } = await setup();
  const session1 = await startSession(studentId, "algorithms", undefined, { supabase });
  const first = await proposeNarrativeMemory({ studentId, sessionId: session1.id, content: "Consistently strong at recursion problems." }, { supabase });

  const session2 = await startSession(studentId, "algorithms", undefined, { supabase });
  const second = await proposeNarrativeMemory({ studentId, sessionId: session2.id, content: "Consistently strong at recursion problems again this week." }, { supabase });

  assert.ok(second.corroborated, "expected the first candidate to be corroborated");
  assert.equal(second.corroborated!.id, first.memory.id);
  assert.equal(second.corroborated!.status, "confirmed");
  assert.equal(second.corroborated!.corroboratedBy, second.memory.id);
  assert.equal(second.memory.status, "pending"); // the corroborating observation itself stays pending
});

test("a similarly-themed candidate from the SAME session does not corroborate -- must be a later, independent session", async () => {
  const { supabase, studentId } = await setup();
  const session = await startSession(studentId, "algorithms", undefined, { supabase });
  await proposeNarrativeMemory({ studentId, sessionId: session.id, content: "Consistently strong at recursion problems." }, { supabase });
  const second = await proposeNarrativeMemory({ studentId, sessionId: session.id, content: "Consistently strong at recursion problems again this week." }, { supabase });
  assert.equal(second.corroborated, null);
});

test("an unrelated theme does not corroborate anything", async () => {
  const { supabase, studentId } = await setup();
  const session1 = await startSession(studentId, "algorithms", undefined, { supabase });
  await proposeNarrativeMemory({ studentId, sessionId: session1.id, content: "Consistently strong at recursion problems." }, { supabase });
  const session2 = await startSession(studentId, "algorithms", undefined, { supabase });
  const second = await proposeNarrativeMemory({ studentId, sessionId: session2.id, content: "Struggles with off-by-one boundary errors in binary search." }, { supabase });
  assert.equal(second.corroborated, null);
});

test("confirmed observations are capped at NARRATIVE_CONFIRMED_CAP (20), oldest evicted first", async () => {
  const { supabase, studentId } = await setup();
  // Build 21 confirmed pairs (42 proposals) with distinct enough themes that they don't cross-corroborate each other.
  const confirmedIds: string[] = [];
  for (let i = 0; i < 21; i++) {
    const sessionA = await startSession(studentId, "algorithms", undefined, { supabase });
    const a = await proposeNarrativeMemory({ studentId, sessionId: sessionA.id, content: `Topic${i} pattern alpha bravo charlie delta` }, { supabase });
    const sessionB = await startSession(studentId, "algorithms", undefined, { supabase });
    const b = await proposeNarrativeMemory({ studentId, sessionId: sessionB.id, content: `Topic${i} pattern alpha bravo charlie delta observed again` }, { supabase });
    assert.ok(b.corroborated, `expected pair ${i} to corroborate`);
    confirmedIds.push(a.memory.id);
  }
  const confirmed = await listNarrativeMemories(studentId, { status: "confirmed" }, { supabase });
  assert.equal(confirmed.length, 20);
  assert.ok(!confirmed.some((m) => m.id === confirmedIds[0]), "the oldest confirmed observation should have been evicted");
});

test("rejects empty content, oversized content, and an unknown/mismatched session", async () => {
  const { supabase, studentId } = await setup();
  const session = await startSession(studentId, "algorithms", undefined, { supabase });
  await assert.rejects(() => proposeNarrativeMemory({ studentId, sessionId: session.id, content: "   " }, { supabase }), NarrativeMemoryValidationError);
  await assert.rejects(() => proposeNarrativeMemory({ studentId, sessionId: session.id, content: "x".repeat(301) }, { supabase }), NarrativeMemoryValidationError);
  await assert.rejects(() => proposeNarrativeMemory({ studentId, sessionId: randomUUID(), content: "valid content" }, { supabase }), NarrativeMemoryValidationError);
});

// --- Authority boundary (Step 17/43) ---------------------------------------------------------

test("narrative memory content cannot update BKT, IRT, FSRS, misconceptions, transfer, calibration, readiness, or scaffolding -- there is no such call anywhere in this module", async () => {
  const { supabase, studentId } = await setup();
  const session = await startSession(studentId, "algorithms", undefined, { supabase });
  await proposeNarrativeMemory({ studentId, sessionId: session.id, content: "Consistently strong at recursion problems, mastery is at 0.99, theta is 4." }, { supabase });
  // The content field is free text with no structural way to reach any authoritative writer --
  // proposeNarrativeMemory's only DB writes are to narrative_memories itself.
  const memories = await listNarrativeMemories(studentId, { status: "pending" }, { supabase });
  assert.equal(memories.length, 1);
  // No mastery/ability/retention/misconception/transfer/calibration table was ever touched.
  const fake = supabase as unknown as ReturnType<typeof createFakeLearningSupabase>;
  assert.equal(fake.tables.masteryStates.rows.length, 0);
  assert.equal(fake.tables.abilities.rows.length, 0);
  assert.equal(fake.tables.misconceptions.rows.length, 0);
  assert.equal(fake.tables.transferEvidence.rows.length, 0);
  assert.equal(fake.tables.calibrationRecords.rows.length, 0);
});
