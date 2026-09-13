// Agent activity logging (Week 4, Phase C; supabase/migrations/013_agent_activity.sql). A minimal,
// human-explainable, append-only record of autonomous decisions the planning/materials layer made --
// NOT learner evidence (that stays in learning_events, migration 004, with its own existing BKT/IRT/
// FSRS/PFA/transfer/misconception consumers). This module has exactly one job: record + list. No
// planning, prioritization, or scoring logic lives here -- every reasonCodes value a caller passes
// in was already computed by lib/learning/recommendations.ts or lib/pedagogy/select.ts.

import "server-only";
import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { AGENT_ACTIVITY_KINDS, type AgentActivityKind, type AgentActivityRecord } from "@/types/agent-activity";

export { AGENT_ACTIVITY_KINDS, type AgentActivityKind, type AgentActivityRecord };

export class AgentActivityValidationError extends Error {}

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

// Schema-complete per migration 013's CHECK constraint (types/agent-activity.ts), but not every kind
// has a call site yet -- mirrors types/learning.ts's own LEARNING_EVENT_TYPES vs.
// EMITTABLE_EVENT_TYPES split. NEXT_ACTION_SELECTED is reserved for a future phase; today's real
// callers only ever emit the other three.
const EMITTABLE_AGENT_ACTIVITY_KINDS: readonly AgentActivityKind[] = ["PLAN_GENERATED", "PLAN_REPLANNED", "MATERIAL_GENERATED"];

// Mirrors lib/learning/events.ts's own METADATA_MAX_BYTES bound, for the identical reason: a
// generous-but-bounded size limit on an arbitrary JSON blob, never a channel for authoritative data.
const METADATA_MAX_BYTES = 4096;

export interface RecordAgentActivityInput {
  studentId: string;
  subject: string;
  kind: AgentActivityKind;
  conceptId?: string | null;
  conceptKey?: string | null;
  reasonCodes?: string[];
  metadata?: Record<string, unknown>;
}

export interface AgentActivityDependencies {
  supabase?: SupabaseClient;
}

function toRow(row: Record<string, unknown>): AgentActivityRecord {
  return {
    id: row.id as string,
    studentId: row.student_id as string,
    subject: row.subject as string,
    kind: row.kind as AgentActivityKind,
    conceptId: (row.concept_id as string | null) ?? null,
    conceptKey: (row.concept_key as string | null) ?? null,
    reasonCodes: Array.isArray(row.reason_codes) ? (row.reason_codes as string[]) : [],
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: row.created_at as string,
  };
}

/** Plain-object, JSON-serializable, size-bounded -- mirrors lib/learning/events.ts::validateMetadata() exactly. */
function validateMetadata(metadata: unknown): Record<string, unknown> {
  if (metadata === undefined || metadata === null) return {};
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new AgentActivityValidationError("Activity metadata must be a plain object.");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(metadata);
  } catch {
    throw new AgentActivityValidationError("Activity metadata must be JSON-serializable.");
  }
  if (Buffer.byteLength(serialized, "utf8") > METADATA_MAX_BYTES) {
    throw new AgentActivityValidationError(`Activity metadata must be ${METADATA_MAX_BYTES} bytes or smaller.`);
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

/**
 * The single write path for this table (mirrors lib/learning/events.ts's own "one central record
 * function" convention) -- there is deliberately no update/delete function anywhere in this module.
 * Callers (lib/plan/generate.ts, lib/materials/service.ts) only ever reach this after their own
 * operation has already succeeded -- never on a failed/rejected attempt, so a row here always means
 * a real autonomous decision actually happened.
 */
export async function recordAgentActivity(input: RecordAgentActivityInput, dependencies: AgentActivityDependencies = {}): Promise<AgentActivityRecord> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();

  if (!input.studentId || typeof input.studentId !== "string") throw new AgentActivityValidationError("A student id is required.");
  if (!input.subject || typeof input.subject !== "string" || !input.subject.trim()) throw new AgentActivityValidationError("A subject is required.");
  if (!EMITTABLE_AGENT_ACTIVITY_KINDS.includes(input.kind)) throw new AgentActivityValidationError(`Unsupported activity kind: ${String(input.kind)}.`);

  const metadata = validateMetadata(input.metadata);

  const { data, error } = await supabase
    .from("agent_activity_log")
    .insert({
      id: randomUUID(),
      student_id: input.studentId,
      subject: input.subject,
      kind: input.kind,
      concept_id: input.conceptId ?? null,
      concept_key: input.conceptKey ?? null,
      reason_codes: input.reasonCodes ?? [],
      metadata,
    })
    .select()
    .single();

  if (error || !data) throw new Error("Could not record agent activity.");
  return toRow(data);
}

export interface ListAgentActivityOptions {
  subject?: string;
  limit?: number;
}

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;

/** Read-only: most recent first, always bounded -- never an unlimited history dump (mirrors lib/learning/recommendations.ts's own bounded-output convention). */
export async function listAgentActivity(studentId: string, options: ListAgentActivityOptions = {}, dependencies: AgentActivityDependencies = {}): Promise<AgentActivityRecord[]> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);

  let query = supabase.from("agent_activity_log").select().eq("student_id", studentId).order("created_at", { ascending: false }).limit(limit);
  if (options.subject) query = query.eq("subject", options.subject);

  const { data, error } = await query;
  if (error) throw new Error("Could not load agent activity.");
  return (data ?? []).map(toRow);
}
