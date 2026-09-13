import assert from "node:assert/strict";
import test from "node:test";
import { EpisodeValidationError, endSession, getSessionEpisode, recordSessionRecap, startSession } from "@/lib/learning/sessions";
import { recordLearningEvent } from "@/lib/learning/events";
import { recordScoredOutcome } from "@/lib/learning/mastery";
import { createOrResolveConcept } from "@/lib/learning/concepts";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { createFakeLearningSupabase } from "./support/fake-learning-db";

async function setup() {
  const fake = createFakeLearningSupabase();
  const supabase = fake as never;
  const profile = await getOrCreateDefaultProfile({ supabase });
  const { concept } = await createOrResolveConcept({ subject: "Algorithms", displayName: "Hashing" }, { supabase });
  return { supabase, fake, studentId: profile.id, conceptId: concept.id };
}

test("a meaningful session (scored attempts, concepts touched) produces a real episode on close", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const session = await startSession(studentId, "algorithms", undefined, { supabase });
  await recordScoredOutcome({ studentId, sessionId: session.id, conceptId, outcome: "correct" }, { supabase });
  await endSession(session.id, studentId, "explicit", undefined, { supabase });

  const episode = await getSessionEpisode(session.id, { supabase });
  assert.equal(episode!.hasMeaningfulEvidence, true);
  assert.deepEqual(episode!.conceptsTouched, [conceptId]);
  assert.equal(episode!.scoredAttempts, 1);
  assert.equal(episode!.correctAttempts, 1);
});

test("a trivial session (no scored attempts, no concept-scoped activity) produces no meaningful episode -- concepts_touched stays empty", async () => {
  const { supabase, studentId } = await setup();
  const session = await startSession(studentId, "algorithms", undefined, { supabase });
  // Only the SESSION_STARTED event exists (from startSession itself) -- no learning evidence.
  await endSession(session.id, studentId, "explicit", undefined, { supabase });

  const episode = await getSessionEpisode(session.id, { supabase });
  assert.equal(episode!.hasMeaningfulEvidence, false);
  assert.deepEqual(episode!.conceptsTouched, []);
  assert.equal(episode!.scoredAttempts, 0);
});

test("trivial UI actions (a bare EXPLANATION_VIEWED with no concept) do not count as meaningful evidence", async () => {
  const { supabase, studentId } = await setup();
  const session = await startSession(studentId, "algorithms", undefined, { supabase });
  await recordLearningEvent({ studentId, sessionId: session.id, eventType: "EXPLANATION_VIEWED" }, { supabase });
  await endSession(session.id, studentId, "explicit", undefined, { supabase });

  const episode = await getSessionEpisode(session.id, { supabase });
  assert.equal(episode!.hasMeaningfulEvidence, false);
});

test("the same session ending twice (idempotent retry) does not duplicate or corrupt concepts_touched", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const session = await startSession(studentId, "algorithms", undefined, { supabase });
  await recordScoredOutcome({ studentId, sessionId: session.id, conceptId, outcome: "correct" }, { supabase });
  const first = await endSession(session.id, studentId, "explicit", "end-key-1", { supabase });
  const retry = await endSession(session.id, studentId, "explicit", "end-key-1", { supabase });
  assert.deepEqual(first.conceptsTouched, [conceptId]);
  assert.deepEqual(retry.conceptsTouched, [conceptId]);
});

test("recordSessionRecap sets the summary exactly once and rejects a second attempt", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const session = await startSession(studentId, "algorithms", undefined, { supabase });
  await recordScoredOutcome({ studentId, sessionId: session.id, conceptId, outcome: "correct" }, { supabase });
  await endSession(session.id, studentId, "explicit", undefined, { supabase });

  const recapped = await recordSessionRecap(session.id, "Practiced hashing and answered correctly.", { supabase });
  assert.equal(recapped.summary, "Practiced hashing and answered correctly.");

  await assert.rejects(() => recordSessionRecap(session.id, "A different recap.", { supabase }), EpisodeValidationError);
});

test("recordSessionRecap rejects an active (not-yet-ended) session", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const session = await startSession(studentId, "algorithms", undefined, { supabase });
  await recordScoredOutcome({ studentId, sessionId: session.id, conceptId, outcome: "correct" }, { supabase });
  await assert.rejects(() => recordSessionRecap(session.id, "Too soon.", { supabase }), EpisodeValidationError);
});

test("recordSessionRecap rejects an empty session -- Step 23's empty-session rule applied to episodic recaps", async () => {
  const { supabase, studentId } = await setup();
  const session = await startSession(studentId, "algorithms", undefined, { supabase });
  await endSession(session.id, studentId, "explicit", undefined, { supabase });
  await assert.rejects(() => recordSessionRecap(session.id, "Nothing happened but here's a recap anyway.", { supabase }), EpisodeValidationError);
});

test("recordSessionRecap rejects empty text and oversized text", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const session = await startSession(studentId, "algorithms", undefined, { supabase });
  await recordScoredOutcome({ studentId, sessionId: session.id, conceptId, outcome: "correct" }, { supabase });
  await endSession(session.id, studentId, "explicit", undefined, { supabase });

  await assert.rejects(() => recordSessionRecap(session.id, "   ", { supabase }), EpisodeValidationError);
  await assert.rejects(() => recordSessionRecap(session.id, "x".repeat(501), { supabase }), EpisodeValidationError);
});

// --- New Chat / empty-session invariants (Step 14/23/41) ------------------------------------

test("New Chat (no session, no events) has no episode to speak of -- getSessionEpisode on a random id returns null", async () => {
  const { supabase } = await setup();
  const episode = await getSessionEpisode("00000000-0000-0000-0000-000000000000", { supabase });
  assert.equal(episode, null);
});
