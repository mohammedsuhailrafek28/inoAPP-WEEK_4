import "server-only";
import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { EMITTABLE_EVENT_TYPES, type EmittableEventType, type LearningEvent } from "@/types/learning";

export class EventValidationError extends Error {}

// Not part of LEARNING_CONFIG (lib/learning/constants.ts): these are general input-validation
// bounds on the event ledger itself (ARCHITECTURE.md §6A scopes that registry to "every
// tunable value referenced anywhere in §7-§23" -- the BKT/IRT/FSRS/etc. learner-intelligence
// algorithms; §25's event catalog is outside that range). Kept as ordinary named constants next to
// the logic they bound, matching how lib/documents/rag.ts defines EVIDENCE_CHAR_BUDGET locally.
const METADATA_MAX_BYTES = 4096;

const UNIQUE_VIOLATION = "23505";

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

function toRow(row: Record<string, unknown>): LearningEvent {
  return {
    id: row.id as string,
    studentId: row.student_id as string,
    sessionId: (row.session_id as string | null) ?? null,
    eventType: row.event_type as LearningEvent["eventType"],
    conceptId: (row.concept_id as string | null) ?? null,
    idempotencyKey: (row.idempotency_key as string | null) ?? null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    occurredAt: row.occurred_at as string,
    createdAt: row.created_at as string,
  };
}

/** Plain-object, JSON-serializable, size-bounded -- never a bypass for authoritative fields (Step 7). */
function validateMetadata(metadata: unknown): Record<string, unknown> {
  if (metadata === undefined || metadata === null) return {};
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new EventValidationError("Event metadata must be a plain object.");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(metadata);
  } catch {
    throw new EventValidationError("Event metadata must be JSON-serializable.");
  }
  if (Buffer.byteLength(serialized, "utf8") > METADATA_MAX_BYTES) {
    throw new EventValidationError(`Event metadata must be ${METADATA_MAX_BYTES} bytes or smaller.`);
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

function validateIdempotencyKey(key: unknown): string | null {
  if (key === undefined || key === null) return null;
  if (typeof key !== "string" || !key.trim()) throw new EventValidationError("Idempotency key must be non-empty text.");
  if (key.length > 200) throw new EventValidationError("Idempotency key must be 200 characters or fewer.");
  return key;
}

export interface RecordLearningEventInput {
  studentId: string;
  eventType: EmittableEventType;
  sessionId?: string | null;
  conceptId?: string | null;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
}

export interface EventDependencies {
  supabase?: SupabaseClient;
}

/**
 * The single, central path every event is written through (Phase 1, Step 12). Every later phase
 * extends EMITTABLE_EVENT_TYPES and calls this same function rather than inventing a separate
 * evidence path -- e.g. Phase 3's QUIZ_ANSWERED events (consumed by lib/learning/mastery.ts) go
 * through here exactly like QUESTION_ASKED does. The one deliberate exception is
 * SESSION_STARTED/SESSION_ENDED, which are inserted atomically inside the
 * start_learning_session/end_learning_session SQL functions (lib/learning/sessions.ts) so they
 * can never exist without their paired session-state change.
 *
 * Authoritative fields (event_type, student_id, session_id, occurred_at) always live in typed
 * columns -- metadata is validated shape/size but is never a channel for bypassing them.
 */
export async function recordLearningEvent(input: RecordLearningEventInput, dependencies: EventDependencies = {}): Promise<LearningEvent> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();

  if (!input.studentId || typeof input.studentId !== "string") throw new EventValidationError("A student id is required to record an event.");
  if (!EMITTABLE_EVENT_TYPES.includes(input.eventType)) {
    throw new EventValidationError(`Unsupported event type for this phase: ${String(input.eventType)}.`);
  }
  const metadata = validateMetadata(input.metadata);
  const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
  const id = randomUUID();

  const { data, error } = await supabase
    .from("learning_events")
    .insert({
      id,
      student_id: input.studentId,
      session_id: input.sessionId ?? null,
      event_type: input.eventType,
      concept_id: input.conceptId ?? null,
      idempotency_key: idempotencyKey,
      metadata,
      // occurred_at is intentionally omitted -- the column default (now()) is the only source of
      // truth; no client-supplied timestamp is ever accepted (Step 17).
    })
    .select()
    .single();

  if (error) {
    if (error.code === UNIQUE_VIOLATION && idempotencyKey) {
      // Same logical event retried with the same key: return the row that already exists rather
      // than erroring or creating a duplicate (Step 9). We deliberately do not compare payloads --
      // ARCHITECTURE.md §20 locks this in as "one column, one index, not a subsystem."
      const existing = await supabase
        .from("learning_events")
        .select()
        .eq("student_id", input.studentId)
        .eq("idempotency_key", idempotencyKey)
        .single();
      if (existing.data) return toRow(existing.data);
    }
    throw new Error("Could not record the learning event.");
  }
  if (!data) throw new Error("Could not record the learning event.");

  // Best-effort session touch (Step 15): a session's own state-changing RPCs already update
  // last_active_at atomically with their own event; for every other event type this is a plain
  // follow-up update. If it fails, the event itself (the authoritative evidence) is still
  // correctly recorded -- staleness detection is explicitly a recovery mechanism, not a precise
  // claim (§31), so a slightly-stale last_active_at in this rare failure case is an acceptable,
  // self-correcting degradation, never a data-loss risk.
  if (input.sessionId) {
    await supabase.from("learning_sessions").update({ last_active_at: new Date().toISOString() }).eq("id", input.sessionId).eq("status", "active");
  }

  return toRow(data);
}

export interface ListEventsOptions {
  sessionId?: string;
  limit?: number;
}

/** Read-only. There is deliberately no update/delete function anywhere in this module (Step 8). */
export async function listEventsForStudent(studentId: string, options: ListEventsOptions = {}, dependencies: EventDependencies = {}): Promise<LearningEvent[]> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  let query = supabase.from("learning_events").select().eq("student_id", studentId).order("occurred_at", { ascending: false });
  if (options.sessionId) query = query.eq("session_id", options.sessionId);
  if (options.limit) query = query.limit(options.limit);
  const { data, error } = await query;
  if (error) throw new Error("Could not load learning events.");
  return (data ?? []).map(toRow);
}
