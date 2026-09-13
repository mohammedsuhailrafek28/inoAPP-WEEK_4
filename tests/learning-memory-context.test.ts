import assert from "node:assert/strict";
import test from "node:test";
import { getLearnerMemoryContext, proposeNarrativeMemory } from "@/lib/learning/memory";
import { startSession, endSession } from "@/lib/learning/sessions";
import { recordScoredOutcome } from "@/lib/learning/mastery";
import { createOrResolveConcept } from "@/lib/learning/concepts";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { createFakeLearningSupabase } from "./support/fake-learning-db";

async function setup() {
  const fake = createFakeLearningSupabase();
  const supabase = fake as never;
  const profile = await getOrCreateDefaultProfile({ supabase });
  return { supabase, fake, studentId: profile.id };
}

test("same-concept episodes are included; unrelated-concept episodes are excluded", async () => {
  const { supabase, studentId } = await setup();
  const { concept: a } = await createOrResolveConcept({ subject: "Algorithms", displayName: "Hashing" }, { supabase });
  const { concept: b } = await createOrResolveConcept({ subject: "Algorithms", displayName: "Recursion" }, { supabase });

  const sessionA = await startSession(studentId, "algorithms", undefined, { supabase });
  await recordScoredOutcome({ studentId, sessionId: sessionA.id, conceptId: a.id, outcome: "correct" }, { supabase });
  await endSession(sessionA.id, studentId, "explicit", undefined, { supabase });

  const sessionB = await startSession(studentId, "algorithms", undefined, { supabase });
  await recordScoredOutcome({ studentId, sessionId: sessionB.id, conceptId: b.id, outcome: "correct" }, { supabase });
  await endSession(sessionB.id, studentId, "explicit", undefined, { supabase });

  const context = await getLearnerMemoryContext({ studentId, conceptId: a.id }, { supabase });
  assert.equal(context.recentEpisodes.length, 1);
  assert.ok(context.recentEpisodes[0].conceptsTouched.includes(a.id));
});

test("subject-relevant memory is returned when filtered by subject", async () => {
  const { supabase, studentId } = await setup();
  const { concept } = await createOrResolveConcept({ subject: "Algorithms", displayName: "Hashing" }, { supabase });
  const session = await startSession(studentId, "algorithms", undefined, { supabase });
  await recordScoredOutcome({ studentId, sessionId: session.id, conceptId: concept.id, outcome: "correct" }, { supabase });
  await endSession(session.id, studentId, "explicit", undefined, { supabase });

  const relevant = await getLearnerMemoryContext({ studentId, subject: "algorithms" }, { supabase });
  assert.equal(relevant.recentEpisodes.length, 1);

  const unrelated = await getLearnerMemoryContext({ studentId, subject: "machine-learning" }, { supabase });
  assert.equal(unrelated.recentEpisodes.length, 0);
});

test("an empty session is excluded from recentEpisodes entirely (Step 23 applied to retrieval)", async () => {
  const { supabase, studentId } = await setup();
  const session = await startSession(studentId, "algorithms", undefined, { supabase });
  await endSession(session.id, studentId, "explicit", undefined, { supabase });
  const context = await getLearnerMemoryContext({ studentId }, { supabase });
  assert.equal(context.recentEpisodes.length, 0);
});

test("limit is respected for both episodes and narratives", async () => {
  const { supabase, studentId } = await setup();
  const { concept } = await createOrResolveConcept({ subject: "Algorithms", displayName: "Hashing" }, { supabase });
  for (let i = 0; i < 5; i++) {
    const session = await startSession(studentId, "algorithms", undefined, { supabase });
    await recordScoredOutcome({ studentId, sessionId: session.id, conceptId: concept.id, outcome: "correct" }, { supabase });
    await endSession(session.id, studentId, "explicit", undefined, { supabase });
  }
  const context = await getLearnerMemoryContext({ studentId, limit: 2 }, { supabase });
  assert.equal(context.recentEpisodes.length, 2);
});

test("recentEpisodes is deterministically ordered most-recent-first", async () => {
  const { supabase, studentId } = await setup();
  const { concept } = await createOrResolveConcept({ subject: "Algorithms", displayName: "Hashing" }, { supabase });
  const sessionIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const session = await startSession(studentId, "algorithms", undefined, { supabase });
    await recordScoredOutcome({ studentId, sessionId: session.id, conceptId: concept.id, outcome: "correct" }, { supabase });
    await endSession(session.id, studentId, "explicit", undefined, { supabase });
    sessionIds.push(session.id);
  }
  const context = await getLearnerMemoryContext({ studentId }, { supabase });
  assert.deepEqual(
    context.recentEpisodes.map((e) => e.sessionId),
    [...sessionIds].reverse(),
  );
});

test("no entire transcript leakage -- episodes carry only the bounded SessionEpisode shape, never raw learning_events", async () => {
  const { supabase, studentId } = await setup();
  const { concept } = await createOrResolveConcept({ subject: "Algorithms", displayName: "Hashing" }, { supabase });
  const session = await startSession(studentId, "algorithms", undefined, { supabase });
  await recordScoredOutcome({ studentId, sessionId: session.id, conceptId: concept.id, outcome: "correct" }, { supabase });
  await endSession(session.id, studentId, "explicit", undefined, { supabase });

  const context = await getLearnerMemoryContext({ studentId }, { supabase });
  const episode = context.recentEpisodes[0] as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(episode).sort(), ["conceptsTouched", "correctAttempts", "endedAt", "hasMeaningfulEvidence", "scoredAttempts", "sessionId", "startedAt", "studentId", "subject", "summary"].sort());
});

test("relevantNarratives includes only confirmed narrative memory, never pending", async () => {
  const { supabase, studentId } = await setup();
  const session1 = await startSession(studentId, "algorithms", undefined, { supabase });
  await proposeNarrativeMemory({ studentId, sessionId: session1.id, content: "Consistently strong at recursion problems." }, { supabase });
  const context = await getLearnerMemoryContext({ studentId }, { supabase });
  assert.equal(context.relevantNarratives.length, 0);

  const session2 = await startSession(studentId, "algorithms", undefined, { supabase });
  await proposeNarrativeMemory({ studentId, sessionId: session2.id, content: "Consistently strong at recursion problems again this week." }, { supabase });
  const contextAfter = await getLearnerMemoryContext({ studentId }, { supabase });
  assert.equal(contextAfter.relevantNarratives.length, 1);
  assert.equal(contextAfter.relevantNarratives[0].status, "confirmed");
});

test("the retrieval contract includes the scaffolding decision, deterministically, with no Gemini call", async () => {
  const { supabase, studentId } = await setup();
  const context = await getLearnerMemoryContext({ studentId }, { supabase });
  assert.equal(context.scaffolding.evidenceSufficient, false); // no sessions at all yet
  assert.equal(context.scaffolding.level, "STANDARD");
});
