// Misconception lifecycle (ARCHITECTURE.md §11, Phase 6; event-sourcing retrofitted in
// Phase 7 -- see below) -- evidence-backed, stronger than the audited source (which lets an
// LLM-proposed label become authoritative instantly, with no confirmation gate). Gemini may
// propose {tag, description} as a CANDIDATE only (§32's authority table); this file's
// recordEvidence() is the sole code path that may ever write `status`/`evidence_count`. Incorrect ≠
// misconception automatically (Step 11) -- every call requires a specific proposed tag tied to a
// real, incorrect, authoritative QUIZ_ANSWERED event.
//
// Phase 7 retrofit: §25's event catalog names a dedicated `MISCONCEPTION_OBSERVED` event
// (`tag`, `proposedByLlm: true`) as the candidate-evidence event -- Phase 6 had instead read the
// tag straight off an incorrect QUIZ_ANSWERED event's own metadata, a gap found on a full re-read
// of §25 while building Phase 7's autonomy signals. Evidence now requires a real
// MISCONCEPTION_OBSERVED event, whose metadata carries `relatedEventId`: the specific QUIZ_ANSWERED
// event it was proposed about (validated to belong to the same student/concept and to be genuinely
// incorrect). This keeps "one interaction" cleanly meaning one QUIZ_ANSWERED event for resolution-
// window purposes, while still tracing every candidate back to a real answer, never inferring
// "incorrect" from the MISCONCEPTION_OBSERVED event's mere existence.
//
// Lifecycle (§11's exact chain): candidate (evidence_count=1) -> active (evidence_count >= 2,
// MISCONCEPTION_ACTIVATION_EVIDENCE_COUNT) -> resolved (the student's last MISCONCEPTION_
// RESOLUTION_WINDOW (3) relevant interactions on the concept, since the misconception was last
// seen, none re-trigger the tag). A resolved misconception that recurs (new evidence for the same
// tag arrives again) reopens to 'active', not a fresh 'candidate' -- evidence_count keeps
// accumulating across the whole lifetime; this is the symmetric, evidence-driven completion of
// §11's own principle ("resolution requires positive evidence," so does reactivation), not
// something the architecture states outright but the only reading consistent with never deleting
// history and never resolving/reactivating on anything but positive evidence.

import "server-only";
import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { LEARNING_CONFIG } from "@/lib/learning/constants";
import { getConcept } from "@/lib/learning/concepts";
import type { Misconception, MisconceptionEvidenceInput, MisconceptionEvidenceResult, MisconceptionEvidenceTransition, MisconceptionStatus } from "@/types/learning";

export class MisconceptionValidationError extends Error {}
export class MisconceptionConcurrencyError extends Error {}

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

const ACTIVATION_EVIDENCE_COUNT = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.MISCONCEPTION_ACTIVATION_EVIDENCE_COUNT.value;
const RESOLUTION_WINDOW = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.MISCONCEPTION_RESOLUTION_WINDOW.value;
const MAX_TAG_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 300;
const CAS_MAX_RETRIES = 5;
const CAS_CONFLICT_MARKER = "misconception_cas_conflict";

export interface MisconceptionDependencies {
  supabase?: SupabaseClient;
}

/**
 * Deterministic, machine-stable identity (mirrors lib/learning/concepts.ts::normalizeConceptKey):
 * "Off-by-one boundary!" and "off_by_one_boundary" both normalize to "off_by_one_boundary" -- §11's
 * own literal example uses underscores, so this uses underscores (not concept keys' hyphens).
 */
export function normalizeMisconceptionTag(input: unknown): string {
  if (typeof input !== "string") throw new MisconceptionValidationError("A misconception tag must be text.");
  const value = input.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/_{2,}/g, "_").replace(/^_+|_+$/g, "");
  if (!value) throw new MisconceptionValidationError("Misconception tag must contain at least one letter or digit.");
  if (value.length > MAX_TAG_LENGTH) throw new MisconceptionValidationError(`Misconception tag must be ${MAX_TAG_LENGTH} characters or fewer once normalized.`);
  return value;
}

function validateDescription(description: string): string {
  const trimmed = description.trim();
  if (!trimmed) throw new MisconceptionValidationError("A misconception description is required.");
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) throw new MisconceptionValidationError(`Misconception description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer.`);
  return trimmed;
}

function toMisconception(row: Record<string, unknown>): Misconception {
  return {
    id: row.id as string,
    studentId: row.student_id as string,
    conceptId: row.concept_id as string,
    tag: row.tag as string,
    description: row.description as string,
    status: row.status as MisconceptionStatus,
    evidenceCount: row.evidence_count as number,
    firstSeenAt: row.first_seen_at as string,
    lastSeenAt: row.last_seen_at as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function toTransition(row: Record<string, unknown>): MisconceptionEvidenceTransition {
  return {
    id: row.id as string,
    studentId: row.student_id as string,
    conceptId: row.concept_id as string,
    tag: row.tag as string,
    sourceEventId: row.source_event_id as string,
    algorithm: "misconception",
    configVersion: row.config_version as number,
    description: row.description as string,
    statusBefore: (row.status_before as MisconceptionStatus | null) ?? null,
    statusAfter: row.status_after as MisconceptionStatus,
    evidenceCountBefore: row.evidence_count_before as number,
    evidenceCountAfter: row.evidence_count_after as number,
    createdAt: row.created_at as string,
  };
}

async function getRow(studentId: string, conceptId: string, tag: string, supabase: SupabaseClient): Promise<Misconception | null> {
  const { data, error } = await supabase.from("misconceptions").select().eq("student_id", studentId).eq("concept_id", conceptId).eq("tag", tag).maybeSingle();
  if (error) throw new Error("Could not load misconception state.");
  return data ? toMisconception(data) : null;
}

function isCasConflict(error: unknown): boolean {
  const message = error && typeof error === "object" && "message" in error ? String((error as { message: unknown }).message) : "";
  return message.includes(CAS_CONFLICT_MARKER);
}

/** Deterministic next status given the current status and the new evidence_count -- the ONLY place activation/reactivation logic lives (never in SQL). */
function nextStatus(currentStatus: MisconceptionStatus | null, newEvidenceCount: number): MisconceptionStatus {
  if (currentStatus === null) return "candidate"; // brand-new evidence, first time ever
  if (currentStatus === "candidate") return newEvidenceCount >= ACTIVATION_EVIDENCE_COUNT ? "active" : "candidate";
  if (currentStatus === "active") return "active";
  return "active"; // resolved -> active: a recurrence is positive evidence the error is back (see file header)
}

/** Public read: current misconceptions for a student, optionally scoped to one concept. */
export async function listMisconceptions(studentId: string, options: { conceptId?: string; status?: MisconceptionStatus } = {}, dependencies: MisconceptionDependencies = {}): Promise<Misconception[]> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  let query = supabase.from("misconceptions").select().eq("student_id", studentId);
  if (options.conceptId) query = query.eq("concept_id", options.conceptId);
  if (options.status) query = query.eq("status", options.status);
  const { data, error } = await query.order("last_seen_at", { ascending: false });
  if (error) throw new Error("Could not load misconceptions.");
  return (data ?? []).map(toMisconception);
}

/**
 * The sole authoritative write path (§32). Requires a real, already-persisted MISCONCEPTION_OBSERVED
 * event (§25) belonging to this student/concept -- "incorrect answer alone" never suffices without
 * also supplying the specific tag a (future, Gemini-assisted) evidence pipeline proposed; this is
 * the trusted internal pathway standing in for that pipeline today, exactly like Phase 3's
 * recordScoredOutcome() stood in for a live quiz UI.
 */
export async function recordMisconceptionEvidence(evidence: MisconceptionEvidenceInput, dependencies: MisconceptionDependencies = {}): Promise<MisconceptionEvidenceResult> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();

  if (!evidence.studentId || typeof evidence.studentId !== "string") throw new MisconceptionValidationError("A student id is required.");
  if (!evidence.conceptId || typeof evidence.conceptId !== "string") throw new MisconceptionValidationError("A concept id is required.");
  if (!evidence.sourceEventId || typeof evidence.sourceEventId !== "string") throw new MisconceptionValidationError("A source event id is required.");
  const tag = normalizeMisconceptionTag(evidence.tag);
  const description = validateDescription(evidence.description);

  const { data: eventRow, error: eventError } = await supabase.from("learning_events").select().eq("id", evidence.sourceEventId).maybeSingle();
  if (eventError) throw new Error("Could not verify the source event.");
  if (!eventRow) throw new MisconceptionValidationError("Unknown source event.");
  if (eventRow.student_id !== evidence.studentId) throw new MisconceptionValidationError("Source event does not belong to this student.");
  if (eventRow.concept_id !== evidence.conceptId) throw new MisconceptionValidationError("Source event is associated with a different concept.");
  if (eventRow.event_type !== "MISCONCEPTION_OBSERVED") throw new MisconceptionValidationError("Misconception evidence must come from a MISCONCEPTION_OBSERVED event.");
  const metadata = (eventRow.metadata ?? {}) as { proposedByLlm?: boolean; relatedEventId?: string };
  if (metadata.proposedByLlm !== true) throw new MisconceptionValidationError("MISCONCEPTION_OBSERVED events must be marked proposedByLlm -- a candidate always originates as an LLM suggestion (§32), never a bare deterministic guess.");
  if (!metadata.relatedEventId || typeof metadata.relatedEventId !== "string") {
    throw new MisconceptionValidationError("MISCONCEPTION_OBSERVED events must reference the QUIZ_ANSWERED event they were proposed about (metadata.relatedEventId).");
  }

  const { data: relatedEventRow, error: relatedEventError } = await supabase.from("learning_events").select().eq("id", metadata.relatedEventId).maybeSingle();
  if (relatedEventError) throw new Error("Could not verify the related answer event.");
  if (!relatedEventRow) throw new MisconceptionValidationError("Unknown related answer event.");
  if (relatedEventRow.student_id !== evidence.studentId || relatedEventRow.concept_id !== evidence.conceptId) {
    throw new MisconceptionValidationError("The related answer event does not belong to this student/concept.");
  }
  if (relatedEventRow.event_type !== "QUIZ_ANSWERED") throw new MisconceptionValidationError("The related event must be a QUIZ_ANSWERED event.");
  const relatedMetadata = (relatedEventRow.metadata ?? {}) as { correct?: boolean };
  if (relatedMetadata.correct !== false) throw new MisconceptionValidationError("Misconception evidence must come from an incorrect answer -- 'incorrect' is never inferred, and a correct answer can never propose one.");

  const concept = await getConcept(evidence.conceptId, { supabase });
  if (!concept) throw new MisconceptionValidationError("Unknown concept.");

  const configVersion = LEARNING_CONFIG.version;

  for (let attempt = 0; attempt < CAS_MAX_RETRIES; attempt++) {
    const current = await getRow(evidence.studentId, evidence.conceptId, tag, supabase);
    const priorEvidenceCount = current?.evidenceCount ?? 0;
    const newEvidenceCount = priorEvidenceCount + 1;
    const priorStatus = current?.status ?? null;
    const newStatus = nextStatus(priorStatus, newEvidenceCount);

    const { data, error } = await supabase.rpc("apply_misconception_evidence", {
      p_transition_id: randomUUID(),
      p_student_id: evidence.studentId,
      p_concept_id: evidence.conceptId,
      p_source_event_id: evidence.sourceEventId,
      p_tag: tag,
      p_description: description,
      p_prior_evidence_count: priorEvidenceCount,
      p_new_evidence_count: newEvidenceCount,
      p_prior_status: priorStatus,
      p_new_status: newStatus,
      p_config_version: configVersion,
    });

    if (error) {
      if (isCasConflict(error)) continue;
      throw new Error("Could not record misconception evidence.");
    }
    const row = (Array.isArray(data) ? data[0] : data) as { status: string; misconception: Record<string, unknown> } | undefined;
    if (!row) throw new Error("Could not record misconception evidence.");

    const { data: transitionRow, error: transitionError } = await supabase.from("misconception_evidence").select().eq("source_event_id", evidence.sourceEventId).maybeSingle();
    if (transitionError || !transitionRow) throw new Error("Could not load the misconception evidence record.");

    return { misconception: toMisconception(row.misconception), transition: toTransition(transitionRow), alreadyProcessed: row.status === "already_processed" };
  }
  throw new MisconceptionConcurrencyError("Could not record misconception evidence after repeated concurrent-update retries.");
}

/**
 * §11's on-read deterministic resolution pass (Step 13): only ever moves 'active' -> 'resolved',
 * and only when at least MISCONCEPTION_RESOLUTION_WINDOW (3) QUIZ_ANSWERED events for this concept
 * have occurred SINCE the misconception was last seen, and NONE of them re-triggered this tag.
 * Never resolves because time passed with zero counter-evidence, and never resolves a 'candidate'
 * (§11's chain is candidate -> active -> resolved, not candidate -> resolved).
 */
export async function reevaluateMisconceptionResolution(studentId: string, conceptId: string, tag: string, dependencies: MisconceptionDependencies = {}): Promise<Misconception | null> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const normalizedTag = normalizeMisconceptionTag(tag);
  const current = await getRow(studentId, conceptId, normalizedTag, supabase);
  if (!current || current.status !== "active") return current;

  const { data: orderedEvents, error: eventsError } = await supabase
    .from("learning_events")
    .select()
    .eq("student_id", studentId)
    .eq("concept_id", conceptId)
    .eq("event_type", "QUIZ_ANSWERED")
    .order("occurred_at", { ascending: true });
  if (eventsError) throw new Error("Could not load recent interactions for resolution.");
  const events = (orderedEvents ?? []) as Record<string, unknown>[];

  const { data: evidenceRows, error: evidenceError } = await supabase.from("misconception_evidence").select().eq("student_id", studentId).eq("concept_id", conceptId).eq("tag", normalizedTag);
  if (evidenceError) throw new Error("Could not check for re-triggering evidence.");

  // Each ledger row's own source_event_id is a MISCONCEPTION_OBSERVED event, not the QUIZ_ANSWERED
  // event it re-triggers -- resolve the correlation via that event's own metadata.relatedEventId
  // (Phase 7 retrofit) so "the last N interactions" keeps meaning "N QUIZ_ANSWERED attempts."
  const observedEventIds = ((evidenceRows ?? []) as Record<string, unknown>[]).map((row) => row.source_event_id as string);
  const relatedIds = await Promise.all(
    observedEventIds.map(async (id) => {
      const { data: observedRow } = await supabase.from("learning_events").select().eq("id", id).maybeSingle();
      return (observedRow?.metadata as { relatedEventId?: string } | undefined)?.relatedEventId ?? null;
    }),
  );
  const evidenceEventIds = new Set(relatedIds.filter((id): id is string => id !== null));

  // Position-based, not last_seen_at-timestamp-based: the most recent evidence-producing event's
  // INDEX in the ordered event list is the resolution window's start. Using array position rather
  // than comparing raw timestamp values sidesteps any millisecond-resolution tie between an event's
  // occurred_at and the misconception's last_seen_at (both are set essentially simultaneously when
  // that evidence is recorded) -- position is unambiguous even when two timestamps would compare equal.
  let lastEvidenceIndex = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (evidenceEventIds.has(events[i].id as string)) {
      lastEvidenceIndex = i;
      break;
    }
  }

  const sinceLastEvidence = events.slice(lastEvidenceIndex + 1);
  if (sinceLastEvidence.length < RESOLUTION_WINDOW) return current; // not enough positive counter-evidence yet

  const window = sinceLastEvidence.slice(-RESOLUTION_WINDOW);
  const reTriggered = window.some((row) => evidenceEventIds.has(row.id as string));
  if (reTriggered) return current;

  const { data, error } = await supabase.from("misconceptions").update({ status: "resolved" }).eq("student_id", studentId).eq("concept_id", conceptId).eq("tag", normalizedTag).eq("status", "active").select().maybeSingle();
  if (error) throw new Error("Could not resolve the misconception.");
  return data ? toMisconception(data) : current;
}
