import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { getOrStartSessionForMeaningfulActivity } from "@/lib/learning/sessions";
import { recordLearningEvent } from "@/lib/learning/events";
import { createFakeLearningSupabase } from "./support/fake-learning-db";

// Mirrors exactly what app/api/rag/route.ts::recordQuestionAskedEvidence() does, composed here
// against a fake DB so the full profile -> session -> event chain is exercised the same way
// Week 2's own tests exercise lib/documents/rag.ts directly rather than the route handler itself
// (this codebase has no route-level HTTP test harness for any endpoint, Week 2 or Week 3).
async function simulateValidatedQuestion(supabase: never, mode: "simple" | "detailed" | "exam" = "simple") {
  const profile = await getOrCreateDefaultProfile({ supabase });
  const session = await getOrStartSessionForMeaningfulActivity(profile.id, undefined, { supabase });
  const event = await recordLearningEvent(
    { studentId: profile.id, sessionId: session.id, eventType: "QUESTION_ASKED", metadata: { mode, selfInitiated: true } },
    { supabase },
  );
  return { profile, session, event };
}

test("the first real question creates a profile, a session, and exactly one QUESTION_ASKED event", async () => {
  const fake = createFakeLearningSupabase();
  const supabase = fake as never;

  const result = await simulateValidatedQuestion(supabase, "simple");

  assert.equal(fake.tables.profiles.rows.length, 1);
  assert.equal(fake.tables.sessions.rows.length, 1);
  assert.equal(result.session.status, "active");
  const questionEvents = fake.tables.events.rows.filter((row) => row.event_type === "QUESTION_ASKED");
  assert.equal(questionEvents.length, 1);
  assert.equal(questionEvents[0].session_id, result.session.id);
  assert.deepEqual(questionEvents[0].metadata, { mode: "simple", selfInitiated: true });
});

test("a second question in the same visit reuses the session and adds a second, distinct event", async () => {
  const fake = createFakeLearningSupabase();
  const supabase = fake as never;

  const first = await simulateValidatedQuestion(supabase, "simple");
  const second = await simulateValidatedQuestion(supabase, "detailed");

  assert.equal(first.session.id, second.session.id);
  assert.equal(fake.tables.sessions.rows.length, 1);
  assert.equal(fake.tables.events.rows.filter((row) => row.event_type === "QUESTION_ASKED").length, 2);
});

test("recordLearningEvent's idempotency key prevents a retried submission from duplicating evidence", async () => {
  // Demonstrates the mechanism a later phase's request-scoped call sites (e.g. quiz submission,
  // which has a natural quiz_id+question_id key) will rely on. The RAG route itself does not
  // attach an idempotency key to QUESTION_ASKED -- Week 2's RAG request has no request-id concept
  // to derive one from, and inventing one would extend that contract beyond "additive only, do not
  // change RAG request shape" (Phase 1 Step 14). A genuine duplicate POST of a question is
  // therefore recorded as separate (low-stakes) evidence today, by design.
  const fake = createFakeLearningSupabase();
  const supabase = fake as never;
  const profile = await getOrCreateDefaultProfile({ supabase });
  const session = await getOrStartSessionForMeaningfulActivity(profile.id, undefined, { supabase });

  const input = { studentId: profile.id, sessionId: session.id, eventType: "QUESTION_ASKED" as const, idempotencyKey: "retry-demo-1" };
  const first = await recordLearningEvent(input, { supabase });
  const retried = await recordLearningEvent(input, { supabase });

  assert.equal(first.id, retried.id);
  assert.equal(fake.tables.events.rows.filter((row) => row.event_type === "QUESTION_ASKED").length, 1);
});

test("app/api/rag/route.ts records evidence additively and personalizes via the ONE extension point -- it still imports the same answerWithRag, never a second/competing RAG function", () => {
  const source = readFileSync(path.join(process.cwd(), "app/api/rag/route.ts"), "utf8");
  // Phase 10 (§21): "answerWithRag() keeps its Revision-1 signature (one new optional dependency:
  // a learner-context fetch)" -- the call now legitimately passes a second argument carrying ONLY
  // that one dependency, never a parallel personalized-RAG function.
  assert.match(source, /answerWithRag\(payload, \{\s*fetchPersonalization:/);
  assert.match(source, /recordQuestionAskedEvidence/);
  // The Week 2 grounding/citation/abstention call is untouched -- the new code only wraps it.
  assert.match(source, /import \{ answerWithRag, RagGenerationError, RagRequestError \} from "@\/lib\/documents\/rag"/);
  assert.doesNotMatch(source, /answerWithPersonalizedRag/);
});

test("\"New Chat\" (app/page.tsx handleClear) creates no learning evidence", () => {
  const source = readFileSync(path.join(process.cwd(), "app/page.tsx"), "utf8");
  const match = source.match(/const handleClear = useCallback\(\(\) => \{[\s\S]*?\}, \[\]\);/);
  assert.ok(match, "expected to find Week 2's handleClear callback unchanged");
  const body = match[0];
  assert.doesNotMatch(body, /fetch\(/);
  assert.doesNotMatch(body, /learning/i);
  assert.match(body, /setMessages\(\[\]\)/);
});
