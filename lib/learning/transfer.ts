// Transfer tracking (ARCHITECTURE.md §12, Phase 6; event-sourcing retrofitted in Phase 7) --
// RECALL/APPLICATION/TRANSFER, not another mastery probability. Counters live as six plain integer
// columns on the SAME learner_concept_state row BKT/FSRS/PFA already share (§27) -- this file never
// reads or writes p_mastery/theta/stability, and nothing in bkt.ts/mastery.ts/irt.ts/ability.ts/
// retention.ts reads a transfer column (Step 19). The readiness ladder is recomputed fresh from the
// counters on every call, never ratcheted or persisted (§12: "a fresh transfer failure can move a
// concept back ... immediately" -- the honest behavior, not permanently "banked" competence).
//
// Phase 7 retrofit: evidence now requires a dedicated TRANSFER_ATTEMPTED event (§25:
// `dimension`/`score`), not a repurposed QUIZ_ANSWERED -- a Phase 6 gap found on a full re-read of
// §25. It is emitted independently of (and typically alongside) the QUIZ_ANSWERED event
// BKT/IRT/FSRS/misconceptions consume for the same real interaction -- the same "one real action,
// multiple independent evidence events, each its own subsystem's concern" pattern used everywhere
// else, just with transfer getting its own named event instead of reusing QUIZ_ANSWERED.

import "server-only";
import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { LEARNING_CONFIG } from "@/lib/learning/constants";
import { getConcept } from "@/lib/learning/concepts";
import type { TransferCounters, TransferEvidenceInput, TransferEvidenceResult, TransferEvidenceTransition, TransferLevel, TransferReadiness, TransferSignal } from "@/types/learning";

export class TransferValidationError extends Error {}
export class TransferConcurrencyError extends Error {}

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

const SUCCESS_THRESHOLD = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.TRANSFER_FAILURE_THRESHOLD.value;
const READY_MIN_SCORE = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.TRANSFER_READY_MIN_SCORE.value;
const CAS_MAX_RETRIES = 5;
const CAS_CONFLICT_MARKER = "transfer_cas_conflict";

export interface TransferDependencies {
  supabase?: SupabaseClient;
}

function toCounters(row: Record<string, unknown>): TransferCounters {
  return {
    recallAttempts: (row.recall_attempts as number) ?? 0,
    recallSuccesses: (row.recall_successes as number) ?? 0,
    applicationAttempts: (row.application_attempts as number) ?? 0,
    applicationSuccesses: (row.application_successes as number) ?? 0,
    transferAttempts: (row.transfer_attempts as number) ?? 0,
    transferSuccesses: (row.transfer_successes as number) ?? 0,
  };
}

function totalAttempts(counters: TransferCounters): number {
  return counters.recallAttempts + counters.applicationAttempts + counters.transferAttempts;
}

function toTransition(row: Record<string, unknown>): TransferEvidenceTransition {
  return {
    id: row.id as string,
    studentId: row.student_id as string,
    conceptId: row.concept_id as string,
    sourceEventId: row.source_event_id as string,
    algorithm: "transfer",
    configVersion: row.config_version as number,
    level: row.level as TransferLevel,
    score: row.score as number,
    success: row.success as boolean,
    evidenceTrust: row.evidence_trust as "deterministic" | "llm_graded",
    createdAt: row.created_at as string,
  };
}

async function getRow(studentId: string, conceptId: string, supabase: SupabaseClient): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase.from("learner_concept_state").select().eq("student_id", studentId).eq("concept_id", conceptId).maybeSingle();
  if (error) throw new Error("Could not load learner concept state.");
  return data ?? null;
}

function isCasConflict(error: unknown): boolean {
  const message = error && typeof error === "object" && "message" in error ? String((error as { message: unknown }).message) : "";
  return message.includes(CAS_CONFLICT_MARKER);
}

/**
 * §12's exact 3-state ladder, pure, recomputed fresh (never persisted). Uses the architecture's own
 * literal names (not_attempted/attempted/ready), not the task prompt's illustrative
 * NO_TRANSFER_EVIDENCE/EMERGING_TRANSFER/DEMONSTRATED_TRANSFER examples.
 */
export function computeTransferReadiness(counters: TransferCounters, mostRecentTransferScore: number | null): TransferReadiness {
  if (counters.transferAttempts === 0 || mostRecentTransferScore === null) return "not_attempted";
  if (counters.applicationSuccesses >= 1 && mostRecentTransferScore >= READY_MIN_SCORE) return "ready";
  return "attempted";
}

/**
 * The one authoritative path that may ever change learner_concept_state's transfer columns (Step
 * 29) -- same CAS-retry-loop shape as BKT/IRT/FSRS. `level` and `score` are always trusted,
 * server-supplied values (a later phase's live quiz-grading pipeline; a trusted internal pathway
 * stands in for it here) -- never client-declared (Step 16). Never mutates p_mastery/theta/stability.
 */
export async function applyTransferEvidence(evidence: TransferEvidenceInput, dependencies: TransferDependencies = {}): Promise<TransferEvidenceResult> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();

  if (!evidence.studentId || typeof evidence.studentId !== "string") throw new TransferValidationError("A student id is required.");
  if (!evidence.conceptId || typeof evidence.conceptId !== "string") throw new TransferValidationError("A concept id is required.");
  if (!evidence.sourceEventId || typeof evidence.sourceEventId !== "string") throw new TransferValidationError("A source event id is required.");
  if (evidence.level !== "recall" && evidence.level !== "application" && evidence.level !== "transfer") throw new TransferValidationError("Level must be 'recall', 'application', or 'transfer'.");
  if (typeof evidence.score !== "number" || !Number.isFinite(evidence.score) || evidence.score < 0 || evidence.score > 1) throw new TransferValidationError("Score must be a finite number in [0, 1].");
  const evidenceTrust = evidence.evidenceTrust ?? "deterministic";
  if (evidenceTrust !== "deterministic" && evidenceTrust !== "llm_graded") throw new TransferValidationError("evidenceTrust must be 'deterministic' or 'llm_graded'.");

  const { data: eventRow, error: eventError } = await supabase.from("learning_events").select().eq("id", evidence.sourceEventId).maybeSingle();
  if (eventError) throw new Error("Could not verify the source event.");
  if (!eventRow) throw new TransferValidationError("Unknown source event.");
  if (eventRow.student_id !== evidence.studentId) throw new TransferValidationError("Source event does not belong to this student.");
  if (eventRow.concept_id && eventRow.concept_id !== evidence.conceptId) throw new TransferValidationError("Source event is associated with a different concept.");
  // §25's event catalog: TRANSFER_ATTEMPTED (`dimension`, `score`) is its own dedicated evidence
  // event, not a repurposed QUIZ_ANSWERED -- a Phase 6 gap, retrofitted in Phase 7 after a full
  // re-read of §25. It is emitted independently of (and typically alongside) the QUIZ_ANSWERED
  // event BKT/IRT/FSRS/misconceptions consume for the same real interaction.
  if (eventRow.event_type !== "TRANSFER_ATTEMPTED") throw new TransferValidationError("Transfer evidence must come from a TRANSFER_ATTEMPTED event.");

  const concept = await getConcept(evidence.conceptId, { supabase });
  if (!concept) throw new TransferValidationError("Unknown concept.");

  const success = evidence.score >= SUCCESS_THRESHOLD;
  const configVersion = LEARNING_CONFIG.version;

  for (let attempt = 0; attempt < CAS_MAX_RETRIES; attempt++) {
    const current = await getRow(evidence.studentId, evidence.conceptId, supabase);
    const priorCounters = current ? toCounters(current) : { recallAttempts: 0, recallSuccesses: 0, applicationAttempts: 0, applicationSuccesses: 0, transferAttempts: 0, transferSuccesses: 0 };
    const priorTotalAttempts = totalAttempts(priorCounters);

    const { data, error } = await supabase.rpc("apply_transfer_evidence", {
      p_transition_id: randomUUID(),
      p_student_id: evidence.studentId,
      p_concept_id: evidence.conceptId,
      p_source_event_id: evidence.sourceEventId,
      p_level: evidence.level,
      p_score: evidence.score,
      p_success: success,
      p_evidence_trust: evidenceTrust,
      p_prior_total_attempts: priorTotalAttempts,
      p_config_version: configVersion,
    });

    if (error) {
      if (isCasConflict(error)) continue;
      throw new Error("Could not apply transfer evidence.");
    }
    const row = (Array.isArray(data) ? data[0] : data) as { status: string; state: Record<string, unknown> } | undefined;
    if (!row) throw new Error("Could not apply transfer evidence.");

    const { data: transitionRow, error: transitionError } = await supabase.from("transfer_evidence").select().eq("source_event_id", evidence.sourceEventId).maybeSingle();
    if (transitionError || !transitionRow) throw new Error("Could not load the transfer evidence record.");

    return { counters: toCounters(row.state), transition: toTransition(transitionRow), alreadyProcessed: row.status === "already_processed" };
  }
  throw new TransferConcurrencyError("Could not apply transfer evidence after repeated concurrent-update retries.");
}

/**
 * Public read: the current transfer signal for one concept (Step 18) -- deliberately not shown
 * with zero attempts (readiness reads "not_attempted" in that case, matching the locked OLM
 * visibility rule: transfer status only meaningfully surfaces after >= 1 transfer attempt).
 */
export async function getTransferSignal(studentId: string, conceptId: string, dependencies: TransferDependencies = {}): Promise<TransferSignal> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const row = await getRow(studentId, conceptId, supabase);
  const counters = row ? toCounters(row) : { recallAttempts: 0, recallSuccesses: 0, applicationAttempts: 0, applicationSuccesses: 0, transferAttempts: 0, transferSuccesses: 0 };

  let mostRecentTransferScore: number | null = null;
  if (counters.transferAttempts > 0) {
    const { data, error } = await supabase
      .from("transfer_evidence")
      .select()
      .eq("student_id", studentId)
      .eq("concept_id", conceptId)
      .eq("level", "transfer")
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw new Error("Could not load transfer evidence history.");
    const latest = (data ?? [])[0] as Record<string, unknown> | undefined;
    mostRecentTransferScore = latest ? (latest.score as number) : null;
  }

  return { studentId, conceptId, counters, mostRecentTransferScore, readiness: computeTransferReadiness(counters, mostRecentTransferScore) };
}
