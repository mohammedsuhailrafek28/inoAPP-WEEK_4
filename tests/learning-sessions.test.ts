import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionError,
  endSession,
  getActiveSession,
  getOrStartSessionForMeaningfulActivity,
  recoverStaleSession,
  startSession,
  touchSession,
} from "@/lib/learning/sessions";
import { LEARNING_CONFIG } from "@/lib/learning/constants";
import { createFakeLearningSupabase } from "./support/fake-learning-db";

const STUDENT_ID = "11111111-1111-1111-1111-111111111111";

function deps() {
  const fake = createFakeLearningSupabase();
  return { supabase: fake as never, fake };
}

test("no active session exists until the first meaningful activity", async () => {
  const { supabase } = deps();
  assert.equal(await getActiveSession(STUDENT_ID, { supabase }), null);
});

test("getOrStartSessionForMeaningfulActivity creates a session on first use", async () => {
  const { supabase, fake } = deps();
  const session = await getOrStartSessionForMeaningfulActivity(STUDENT_ID, "algorithms", { supabase });
  assert.equal(session.studentId, STUDENT_ID);
  assert.equal(session.subject, "algorithms");
  assert.equal(session.status, "active");
  assert.equal(fake.tables.sessions.rows.length, 1);
  // Starting a session is itself evidence: exactly one SESSION_STARTED event, referencing the session.
  const started = fake.tables.events.rows.filter((row) => row.event_type === "SESSION_STARTED");
  assert.equal(started.length, 1);
  assert.equal(started[0].session_id, session.id);
});

test("an active session is reused rather than duplicated", async () => {
  const { supabase, fake } = deps();
  const first = await getOrStartSessionForMeaningfulActivity(STUDENT_ID, "algorithms", { supabase });
  const second = await getOrStartSessionForMeaningfulActivity(STUDENT_ID, "algorithms", { supabase });
  assert.equal(first.id, second.id);
  assert.equal(fake.tables.sessions.rows.length, 1);
  assert.equal(fake.tables.events.rows.filter((row) => row.event_type === "SESSION_STARTED").length, 1);
});

test("touchSession bumps last_active_at on the active session only", async () => {
  const { supabase, fake } = deps();
  const session = await startSession(STUDENT_ID, "algorithms", undefined, { supabase });
  const before = fake.tables.sessions.rows[0].last_active_at as string;
  await new Promise((resolve) => setTimeout(resolve, 5));
  await touchSession(session.id, { supabase });
  const after = fake.tables.sessions.rows[0].last_active_at as string;
  assert.notEqual(before, after);
  assert.ok(new Date(after).getTime() > new Date(before).getTime());
});

test("explicit end is authoritative and immediate, with end_reason='explicit'", async () => {
  const { supabase, fake } = deps();
  const session = await startSession(STUDENT_ID, "algorithms", undefined, { supabase });
  const ended = await endSession(session.id, STUDENT_ID, "explicit", undefined, { supabase });
  assert.equal(ended.status, "ended");
  assert.equal(ended.endReason, "explicit");
  assert.ok(ended.endedAt);
  const endedEvents = fake.tables.events.rows.filter((row) => row.event_type === "SESSION_ENDED");
  assert.equal(endedEvents.length, 1);
  assert.equal((endedEvents[0].metadata as { end_reason: string }).end_reason, "explicit");
});

test("stale-timeout recovery closes an abandoned session using the centralized 90-minute threshold", async () => {
  const { supabase, fake } = deps();
  const session = await startSession(STUDENT_ID, "algorithms", undefined, { supabase });
  assert.equal(LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.STALE_SESSION_MINUTES.value, 90);

  // Backdate last_active_at past the threshold -- this is the ONLY input recoverStaleSession reads.
  const staleTimestamp = new Date(Date.now() - 91 * 60_000).toISOString();
  const row = fake.tables.sessions.rows.find((r) => r.id === session.id)!;
  row.last_active_at = staleTimestamp;

  const recovered = await recoverStaleSession(STUDENT_ID, { supabase });
  assert.equal(recovered!.status, "ended");
  assert.equal(recovered!.endReason, "stale_timeout");
});

test("a session inside the 90-minute window is NOT treated as stale", async () => {
  const { supabase, fake } = deps();
  const session = await startSession(STUDENT_ID, "algorithms", undefined, { supabase });
  const row = fake.tables.sessions.rows.find((r) => r.id === session.id)!;
  row.last_active_at = new Date(Date.now() - 89 * 60_000).toISOString();

  const recovered = await recoverStaleSession(STUDENT_ID, { supabase });
  assert.equal(recovered!.id, session.id);
  assert.equal(recovered!.status, "active");
});

test("starting a new explicit session safely supersedes an existing active one", async () => {
  const { supabase, fake } = deps();
  const first = await startSession(STUDENT_ID, "algorithms", undefined, { supabase });
  const second = await startSession(STUDENT_ID, "databases", undefined, { supabase });

  assert.notEqual(first.id, second.id);
  const firstRow = fake.tables.sessions.rows.find((r) => r.id === first.id)!;
  assert.equal(firstRow.status, "ended");
  assert.equal(firstRow.end_reason, "superseded");
  assert.equal(fake.tables.sessions.rows.filter((r) => r.status === "active").length, 1);
});

test("session start/end timestamps are always server time -- the public API has no timestamp parameter", async () => {
  const { supabase } = deps();
  const before = Date.now();
  const session = await startSession(STUDENT_ID, "algorithms", undefined, { supabase });
  const after = Date.now();
  const startedAtMs = new Date(session.startedAt).getTime();
  assert.ok(startedAtMs >= before && startedAtMs <= after);
  // startSession(studentId, subject?, idempotencyKey?, dependencies?) -- no timestamp slot exists
  // for a caller to influence; this is a structural guarantee enforced by the signature itself.
});

test("start/end session idempotency keys prevent duplicate sessions/events on retry", async () => {
  const { supabase, fake } = deps();
  const first = await startSession(STUDENT_ID, "algorithms", "start-key-1", { supabase });
  const retry = await startSession(STUDENT_ID, "algorithms", "start-key-1", { supabase });
  assert.equal(first.id, retry.id);
  assert.equal(fake.tables.sessions.rows.length, 1);
  assert.equal(fake.tables.events.rows.filter((row) => row.event_type === "SESSION_STARTED").length, 1);

  await endSession(first.id, STUDENT_ID, "explicit", "end-key-1", { supabase });
  await endSession(first.id, STUDENT_ID, "explicit", "end-key-1", { supabase });
  assert.equal(fake.tables.events.rows.filter((row) => row.event_type === "SESSION_ENDED").length, 1);
});

test("ending an already-ended session is a safe no-op, not an error", async () => {
  const { supabase } = deps();
  const session = await startSession(STUDENT_ID, "algorithms", undefined, { supabase });
  await endSession(session.id, STUDENT_ID, "explicit", undefined, { supabase });
  const result = await endSession(session.id, STUDENT_ID, "explicit", undefined, { supabase });
  assert.equal(result.status, "ended");
});

test("an invalid end reason is rejected", async () => {
  const { supabase } = deps();
  const session = await startSession(STUDENT_ID, "algorithms", undefined, { supabase });
  await assert.rejects(() => endSession(session.id, STUDENT_ID, "because" as never, undefined, { supabase }), SessionError);
});
