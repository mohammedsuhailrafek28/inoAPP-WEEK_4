import "server-only";
import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { LEARNING_CONFIG } from "@/lib/learning/constants";
import { normalizeSubjectKey } from "@/lib/learning/concepts";
import type { LearningSession, SessionEndReason, SessionEpisode } from "@/types/learning";

export class SessionError extends Error {}
export class EpisodeValidationError extends Error {}

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

const STALE_SESSION_MINUTES = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.STALE_SESSION_MINUTES.value;
// A plain input-validation bound, not a §6A policy tunable (same reasoning as concepts.ts's own
// MAX_CONCEPT_KEY_LENGTH/profile.ts's text bounds) -- the episodic recap is a session-level
// summary, not narrative memory's own, separately-bounded, one-sentence observation (§5.1).
const MAX_SESSION_RECAP_LENGTH = 500;

function toRow(row: Record<string, unknown>): LearningSession {
  return {
    id: row.id as string,
    studentId: row.student_id as string,
    subject: row.subject as string,
    status: row.status as LearningSession["status"],
    startedAt: row.started_at as string,
    lastActiveAt: row.last_active_at as string,
    endedAt: (row.ended_at as string | null) ?? null,
    endReason: (row.end_reason as SessionEndReason | null) ?? null,
    conceptsTouched: Array.isArray(row.concepts_touched) ? (row.concepts_touched as string[]) : [],
    summary: (row.summary as string | null) ?? null,
  };
}

function minutesSince(isoTimestamp: string, now: Date): number {
  return (now.getTime() - new Date(isoTimestamp).getTime()) / 60_000;
}

/**
 * Episodic memory (§5 Layer D), derived, never invented: concepts_touched is deterministically
 * recomputed from this session's own learning_events every time a session ends -- not threaded
 * through every individual event-write call site (Step 10's "prefer deriving on demand"). Running
 * this twice (e.g. an idempotent end-session retry) recomputes the identical result, so no separate
 * idempotency guard is needed here.
 */
async function deriveConceptsTouched(sessionId: string, supabase: SupabaseClient): Promise<string[]> {
  const { data, error } = await supabase.from("learning_events").select().eq("session_id", sessionId);
  if (error) throw new Error("Could not load session events for episode derivation.");
  const conceptIds = new Set<string>();
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    if (row.concept_id) conceptIds.add(row.concept_id as string);
  }
  return [...conceptIds];
}

async function finalizeSessionEpisode(sessionId: string, sessionRow: Record<string, unknown>, supabase: SupabaseClient): Promise<Record<string, unknown>> {
  const conceptsTouched = await deriveConceptsTouched(sessionId, supabase);
  const { error } = await supabase.from("learning_sessions").update({ concepts_touched: conceptsTouched }).eq("id", sessionId);
  if (error) throw new Error("Could not finalize the session episode.");
  return { ...sessionRow, concepts_touched: conceptsTouched };
}

export interface SessionDependencies {
  supabase?: SupabaseClient;
}

/** The student's currently-open session, or null. Does not perform staleness recovery by itself. */
export async function getActiveSession(studentId: string, dependencies: SessionDependencies = {}): Promise<LearningSession | null> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const { data, error } = await supabase.from("learning_sessions").select().eq("student_id", studentId).eq("status", "active").maybeSingle();
  if (error) throw new Error("Could not load the active learning session.");
  return data ? toRow(data) : null;
}

/**
 * Server-authoritative staleness recovery (§31, Decision 2 -- LOCKED). A recovery mechanism, not a
 * precise "the learner stopped now" claim: if the active session's last_active_at is older than
 * STALE_SESSION_MINUTES (read from LEARNING_CONFIG, never hardcoded here), it is closed safely
 * with end_reason='stale_timeout' before anything else runs. Idempotency key is derived from the
 * session id so a stale check racing with itself across concurrent requests can never double-close.
 */
export async function recoverStaleSession(studentId: string, dependencies: SessionDependencies = {}): Promise<LearningSession | null> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const active = await getActiveSession(studentId, { supabase });
  if (!active) return null;
  if (minutesSince(active.lastActiveAt, new Date()) < STALE_SESSION_MINUTES) return active;

  const { data, error } = await supabase.rpc("end_learning_session", {
    p_session_id: active.id,
    p_student_id: studentId,
    p_end_reason: "stale_timeout" satisfies SessionEndReason,
    p_event_id: randomUUID(),
    p_idempotency_key: `stale-timeout-${active.id}`,
  });
  if (error || !data) throw new Error("Could not close the stale learning session.");
  const finalized = await finalizeSessionEpisode(active.id, data as Record<string, unknown>, supabase);
  return toRow(finalized);
}

/**
 * Starts a new learning session, atomically superseding any still-open one (§31: "a student is
 * never left with two active sessions"). Session/event identity and timestamps are all
 * server-generated -- no caller ever supplies them (Step 17).
 */
export async function startSession(
  studentId: string,
  subject = "general",
  idempotencyKey?: string,
  dependencies: SessionDependencies = {},
): Promise<LearningSession> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  // Phase 2 consistency fix: normalized the same way learning_concepts.subject and
  // learner_ability.subject (Phase 3+) are, so "Algorithms", "algorithms ", and "algorithms" all
  // scope to the same session/subject identity (Step 5 -- "subject identity must be stable and
  // deterministic ... do not derive it from arbitrary user display strings at runtime").
  const normalizedSubject = normalizeSubjectKey(subject);
  const { data, error } = await supabase.rpc("start_learning_session", {
    p_student_id: studentId,
    p_subject: normalizedSubject,
    p_session_id: randomUUID(),
    p_event_id: randomUUID(),
    p_idempotency_key: idempotencyKey ?? null,
  });
  if (error || !data) throw new SessionError("Could not start a learning session.");
  return toRow(data as Record<string, unknown>);
}

/** Explicit end -- always authoritative and trusted immediately (§31), unlike stale recovery. */
export async function endSession(
  sessionId: string,
  studentId: string,
  reason: SessionEndReason,
  idempotencyKey?: string,
  dependencies: SessionDependencies = {},
): Promise<LearningSession> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const { data, error } = await supabase.rpc("end_learning_session", {
    p_session_id: sessionId,
    p_student_id: studentId,
    p_end_reason: reason,
    p_event_id: randomUUID(),
    p_idempotency_key: idempotencyKey ?? null,
  });
  if (error || !data) throw new SessionError("Could not end the learning session.");
  const finalized = await finalizeSessionEpisode(sessionId, data as Record<string, unknown>, supabase);
  return toRow(finalized);
}

/** Explicit, on-demand touch. recordLearningEvent() already does this automatically per event. */
export async function touchSession(sessionId: string, dependencies: SessionDependencies = {}): Promise<void> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const { error } = await supabase
    .from("learning_sessions")
    .update({ last_active_at: new Date().toISOString() })
    .eq("id", sessionId)
    .eq("status", "active");
  if (error) throw new Error("Could not update the learning session.");
}

/**
 * The one entry point meaningful-activity call sites should use (Step 14): recovers a stale
 * session first, reuses an active session if one exists, or starts a new one. "Meaningful" is
 * decided entirely by the caller choosing to call this at all -- plain navigation/UI clicks must
 * never call it, and calling it never happens as a side effect of merely rendering a page (§31).
 */
export async function getOrStartSessionForMeaningfulActivity(
  studentId: string,
  subject = "general",
  dependencies: SessionDependencies = {},
): Promise<LearningSession> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const recovered = await recoverStaleSession(studentId, { supabase });
  if (recovered && recovered.status === "active") return recovered;
  return startSession(studentId, subject, undefined, { supabase });
}

/**
 * Episodic memory read (§5 Layer D, Phase 7, Step 13): concrete, grounded learning history for one
 * session -- never a raw transcript dump. `hasMeaningfulEvidence` is Step 23's empty-session gate,
 * exposed so callers (e.g. recordSessionRecap, memory retrieval) never treat a session that had no
 * real learning evidence as if it did.
 */
export async function getSessionEpisode(sessionId: string, dependencies: SessionDependencies = {}): Promise<SessionEpisode | null> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const { data: sessionRow, error: sessionError } = await supabase.from("learning_sessions").select().eq("id", sessionId).maybeSingle();
  if (sessionError) throw new Error("Could not load the learning session.");
  if (!sessionRow) return null;

  const { data: scoredEvents, error: eventsError } = await supabase.from("learning_events").select().eq("session_id", sessionId).eq("event_type", "QUIZ_ANSWERED");
  if (eventsError) throw new Error("Could not load session events.");
  const rows = (scoredEvents ?? []) as Record<string, unknown>[];
  const correctAttempts = rows.filter((row) => (row.metadata as { correct?: boolean } | null)?.correct === true).length;

  const conceptsTouched = Array.isArray(sessionRow.concepts_touched) ? (sessionRow.concepts_touched as string[]) : [];
  const hasMeaningfulEvidence = rows.length > 0 || conceptsTouched.length > 0;

  return {
    sessionId,
    studentId: sessionRow.student_id as string,
    subject: sessionRow.subject as string,
    startedAt: sessionRow.started_at as string,
    endedAt: (sessionRow.ended_at as string | null) ?? null,
    conceptsTouched,
    scoredAttempts: rows.length,
    correctAttempts,
    hasMeaningfulEvidence,
    summary: (sessionRow.summary as string | null) ?? null,
  };
}

/**
 * Sets a session's one-time episodic recap (§5 Layer D: "Recap set once at session close"). The
 * text itself is `llm_observed` in the architecture's own provenance table -- this function is the
 * validation/persistence boundary a future Gemini-integration phase's call site would use; it never
 * calls Gemini itself (no live UI exists yet, the same pattern as every other evidence-recording
 * function in this codebase). Rejects: a still-active session (recap is only for a closed episode),
 * a session that already has a recap (set once, never silently overwritten), an empty/oversized
 * recap, and -- Step 23's empty-session rule -- a session with zero meaningful learning evidence,
 * so a fake recap can never be attached to a session where nothing happened.
 */
export async function recordSessionRecap(sessionId: string, recap: string, dependencies: SessionDependencies = {}): Promise<LearningSession> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const trimmed = recap.trim();
  if (!trimmed) throw new EpisodeValidationError("A session recap must not be empty.");
  if (trimmed.length > MAX_SESSION_RECAP_LENGTH) throw new EpisodeValidationError(`A session recap must be ${MAX_SESSION_RECAP_LENGTH} characters or fewer.`);

  const episode = await getSessionEpisode(sessionId, { supabase });
  if (!episode) throw new EpisodeValidationError("Unknown session.");
  if (episode.endedAt === null) throw new EpisodeValidationError("A recap can only be recorded for a session that has already ended.");
  if (episode.summary !== null) throw new EpisodeValidationError("This session already has a recap -- recaps are set once, never overwritten.");
  if (!episode.hasMeaningfulEvidence) throw new EpisodeValidationError("A session with no meaningful learning evidence cannot receive a recap.");

  const { data, error } = await supabase.from("learning_sessions").update({ summary: trimmed }).eq("id", sessionId).select().maybeSingle();
  if (error || !data) throw new Error("Could not record the session recap.");
  return toRow(data);
}
