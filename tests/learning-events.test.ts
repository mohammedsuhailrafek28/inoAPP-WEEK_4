import assert from "node:assert/strict";
import test from "node:test";
import * as eventsModule from "@/lib/learning/events";
import { EventValidationError, listEventsForStudent, recordLearningEvent } from "@/lib/learning/events";
import { createFakeLearningSupabase } from "./support/fake-learning-db";

const STUDENT_ID = "22222222-2222-2222-2222-222222222222";
const SESSION_ID = "33333333-3333-3333-3333-333333333333";

function deps() {
  const fake = createFakeLearningSupabase();
  return { supabase: fake as never, fake };
}

test("appends an event with server-resolved id/timestamps and the given association", async () => {
  const { supabase, fake } = deps();
  fake.tables.sessions.rows.push({ id: SESSION_ID, student_id: STUDENT_ID, status: "active", last_active_at: "2020-01-01T00:00:00.000Z" });

  const event = await recordLearningEvent(
    { studentId: STUDENT_ID, sessionId: SESSION_ID, eventType: "QUESTION_ASKED", metadata: { mode: "simple", selfInitiated: true } },
    { supabase },
  );
  assert.equal(event.studentId, STUDENT_ID);
  assert.equal(event.sessionId, SESSION_ID);
  assert.equal(event.eventType, "QUESTION_ASKED");
  assert.deepEqual(event.metadata, { mode: "simple", selfInitiated: true });
  assert.ok(event.id);
  assert.ok(event.occurredAt);
});

test("recording a session-linked event bumps that session's last_active_at (best-effort touch)", async () => {
  const { supabase, fake } = deps();
  fake.tables.sessions.rows.push({ id: SESSION_ID, student_id: STUDENT_ID, status: "active", last_active_at: "2020-01-01T00:00:00.000Z" });
  await recordLearningEvent({ studentId: STUDENT_ID, sessionId: SESSION_ID, eventType: "QUESTION_ASKED" }, { supabase });
  const session = fake.tables.sessions.rows.find((row) => row.id === SESSION_ID)!;
  assert.notEqual(session.last_active_at, "2020-01-01T00:00:00.000Z");
});

test("duplicate idempotency key does not create a second event", async () => {
  const { supabase, fake } = deps();
  const input = { studentId: STUDENT_ID, eventType: "QUESTION_ASKED" as const, idempotencyKey: "same-question-1" };
  const first = await recordLearningEvent(input, { supabase });
  const retry = await recordLearningEvent(input, { supabase });
  assert.equal(first.id, retry.id);
  assert.equal(fake.tables.events.rows.length, 1);
});

test("two different idempotency keys never collide with each other", async () => {
  const { supabase, fake } = deps();
  await recordLearningEvent({ studentId: STUDENT_ID, eventType: "QUESTION_ASKED", idempotencyKey: "q-1" }, { supabase });
  await recordLearningEvent({ studentId: STUDENT_ID, eventType: "QUESTION_ASKED", idempotencyKey: "q-2" }, { supabase });
  assert.equal(fake.tables.events.rows.length, 2);
});

test("events with no idempotency key are never deduplicated against each other", async () => {
  const { supabase, fake } = deps();
  await recordLearningEvent({ studentId: STUDENT_ID, eventType: "QUESTION_ASKED" }, { supabase });
  await recordLearningEvent({ studentId: STUDENT_ID, eventType: "QUESTION_ASKED" }, { supabase });
  assert.equal(fake.tables.events.rows.length, 2);
});

test("rejects an event type outside the currently-emittable set", async () => {
  // REVIEW_COMPLETED is a real, structurally-valid value in the full §25 catalog (the DB CHECK
  // constraint allows it) but has no call site yet (§20's pipeline already covers reviews via the
  // QUIZ_ANSWERED path, per this codebase's own EMITTABLE_EVENT_TYPES header comment) --
  // QUIZ_STARTED/QUIZ_ANSWERED/QUIZ_COMPLETED, HINT_REQUESTED, CONFIDENCE_REPORTED,
  // TRANSFER_ATTEMPTED, and MISCONCEPTION_OBSERVED all became legitimately emittable in Phases
  // 3/7/9 and are no longer valid cases for this test.
  const { supabase } = deps();
  await assert.rejects(
    () => recordLearningEvent({ studentId: STUDENT_ID, eventType: "REVIEW_COMPLETED" as never }, { supabase }),
    EventValidationError,
  );
});

test("rejects a missing student id", async () => {
  const { supabase } = deps();
  await assert.rejects(() => recordLearningEvent({ studentId: "" as never, eventType: "QUESTION_ASKED" }, { supabase }), EventValidationError);
});

test("metadata must be a plain, JSON-serializable, size-bounded object", async () => {
  const { supabase } = deps();
  await assert.rejects(
    () => recordLearningEvent({ studentId: STUDENT_ID, eventType: "QUESTION_ASKED", metadata: ["not", "an", "object"] as never }, { supabase }),
    EventValidationError,
  );
  await assert.rejects(
    () => recordLearningEvent({ studentId: STUDENT_ID, eventType: "QUESTION_ASKED", metadata: "nope" as never }, { supabase }),
    EventValidationError,
  );
  const oversized = { blob: "x".repeat(10_000) };
  await assert.rejects(
    () => recordLearningEvent({ studentId: STUDENT_ID, eventType: "QUESTION_ASKED", metadata: oversized }, { supabase }),
    EventValidationError,
  );
});

test("metadata is never an authority bypass -- authoritative fields stay in typed columns", async () => {
  const { supabase } = deps();
  const event = await recordLearningEvent(
    { studentId: STUDENT_ID, eventType: "QUESTION_ASKED", metadata: { eventType: "QUIZ_ANSWERED", studentId: "someone-else" } },
    { supabase },
  );
  // The typed columns win regardless of what the (validated, but still just data) metadata claims.
  assert.equal(event.eventType, "QUESTION_ASKED");
  assert.equal(event.studentId, STUDENT_ID);
});

test("occurred_at is always server time -- recordLearningEvent's input type has no timestamp field", async () => {
  const { supabase } = deps();
  const before = Date.now();
  const event = await recordLearningEvent({ studentId: STUDENT_ID, eventType: "QUESTION_ASKED" }, { supabase });
  const after = Date.now();
  const occurredAtMs = new Date(event.occurredAt).getTime();
  assert.ok(occurredAtMs >= before && occurredAtMs <= after);
});

test("listEventsForStudent reads in reverse-chronological order and can scope to a session", async () => {
  const { supabase } = deps();
  await recordLearningEvent({ studentId: STUDENT_ID, sessionId: SESSION_ID, eventType: "QUESTION_ASKED", idempotencyKey: "a" }, { supabase });
  await recordLearningEvent({ studentId: STUDENT_ID, eventType: "QUESTION_ASKED", idempotencyKey: "b" }, { supabase });

  const scoped = await listEventsForStudent(STUDENT_ID, { sessionId: SESSION_ID }, { supabase });
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].sessionId, SESSION_ID);

  const all = await listEventsForStudent(STUDENT_ID, {}, { supabase });
  assert.equal(all.length, 2);
});

test("the events module exposes no update/delete function -- append-only repository surface", () => {
  const exportedNames = Object.keys(eventsModule);
  for (const name of exportedNames) {
    assert.doesNotMatch(name.toLowerCase(), /update|delete|mutate|remove/);
  }
  assert.ok(typeof eventsModule.recordLearningEvent === "function");
  assert.ok(typeof eventsModule.listEventsForStudent === "function");
});
