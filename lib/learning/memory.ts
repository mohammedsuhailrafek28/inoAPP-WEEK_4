// Narrative memory (ARCHITECTURE.md §5 Layer E, §5.1, Phase 7) + the Step 24 memory
// retrieval contract for future pedagogy/personalized RAG.
//
// Narrative memory is a compact, longitudinal INTERPRETATION -- never authoritative learner state
// (Step 17). Nothing in this file, or reachable from it, ever writes p_mastery/theta/stability,
// activates a misconception, marks transfer, changes calibration, changes prerequisite readiness,
// or sets scaffolding: it has no import of bkt.ts/irt.ts/retention.ts/misconceptions.ts's writers/
// transfer.ts's writer/calibration.ts's writers/autonomy.ts's writer, and could not call them even
// if it tried -- read-only access to already-derived state (readiness/misconceptions/autonomy) is
// the only overlap.
//
// Corroboration (§5.1) is the sole promotion path: a single LLM utterance is never authoritative,
// exactly the fix over the audited source's own misconception-lifecycle gap (§11), applied here too.

import "server-only";
import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { LEARNING_CONFIG } from "@/lib/learning/constants";
import { listMisconceptions } from "@/lib/learning/misconceptions";
import { getScaffoldingDecision } from "@/lib/learning/autonomy";
import { getSessionEpisode } from "@/lib/learning/sessions";
import type { LearnerMemoryContext, LearnerMemoryContextQuery, NarrativeMemory, ProposeNarrativeMemoryInput } from "@/types/learning";

export class NarrativeMemoryValidationError extends Error {}

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

const MAX_LENGTH = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.NARRATIVE_CANDIDATE_MAX_LENGTH.value;
const SIMILARITY_THRESHOLD = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.NARRATIVE_CORROBORATION_SIMILARITY.value;
const CONFIRMED_CAP = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.NARRATIVE_CONFIRMED_CAP.value;
const PENDING_CAP = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.NARRATIVE_PENDING_CAP.value;
const DEFAULT_MEMORY_LIMIT = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.MEMORY_CONTEXT_DEFAULT_LIMIT.value;
const MAX_SESSIONS_SCANNED = 50; // a defensive replay bound, matching autonomy.ts's own local convention -- not a policy threshold

export interface MemoryDependencies {
  supabase?: SupabaseClient;
}

function toNarrativeMemory(row: Record<string, unknown>): NarrativeMemory {
  return {
    id: row.id as string,
    studentId: row.student_id as string,
    sessionId: row.session_id as string,
    content: row.content as string,
    status: row.status as NarrativeMemory["status"],
    corroboratedBy: (row.corroborated_by as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

/** Deterministic, no embedding call (§5.1: "a cheap string-similarity check"). */
function normalizedTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 0),
  );
}

/** Jaccard similarity (intersection / union) -- "normalized token overlap," pure. */
export function narrativeThemeSimilarity(a: string, b: string): number {
  const tokensA = normalizedTokens(a);
  const tokensB = normalizedTokens(b);
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const token of tokensA) if (tokensB.has(token)) intersection += 1;
  const union = tokensA.size + tokensB.size - intersection;
  return intersection / union;
}

async function validateSession(studentId: string, sessionId: string, supabase: SupabaseClient): Promise<void> {
  const { data, error } = await supabase.from("learning_sessions").select().eq("id", sessionId).maybeSingle();
  if (error) throw new Error("Could not verify the session.");
  if (!data) throw new NarrativeMemoryValidationError("Unknown session.");
  if (data.student_id !== studentId) throw new NarrativeMemoryValidationError("Session does not belong to this student.");
}

/**
 * Gemini may propose a candidate any time (§32) -- this is the validation/persistence boundary a
 * future live pipeline's call site would use (no live Gemini call exists yet, the same "trusted
 * pathway stands in" pattern used everywhere else in this codebase). `content` is bounded and
 * schema-checked here; it is never trusted to introduce facts beyond what the caller supplies, and
 * this function alone decides `status` -- the LLM's authority ends at proposing `content` (§17).
 *
 * Corroboration (§5.1): if an EARLIER, still-pending candidate from a DIFFERENT (earlier) session
 * has a similar theme (token-overlap >= NARRATIVE_CORROBORATION_SIMILARITY), that earlier candidate
 * -- not this new one -- is promoted to 'confirmed', referencing this one as its corroboration.
 */
export async function proposeNarrativeMemory(input: ProposeNarrativeMemoryInput, dependencies: MemoryDependencies = {}): Promise<{ memory: NarrativeMemory; corroborated: NarrativeMemory | null }> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  if (!input.studentId || typeof input.studentId !== "string") throw new NarrativeMemoryValidationError("A student id is required.");
  if (!input.sessionId || typeof input.sessionId !== "string") throw new NarrativeMemoryValidationError("A session id is required.");
  const content = input.content.trim();
  if (!content) throw new NarrativeMemoryValidationError("Narrative memory content must not be empty.");
  if (content.length > MAX_LENGTH) throw new NarrativeMemoryValidationError(`Narrative memory content must be ${MAX_LENGTH} characters or fewer.`);

  await validateSession(input.studentId, input.sessionId, supabase);

  const { data: existingRows, error: existingError } = await supabase.from("narrative_memories").select().eq("student_id", input.studentId).eq("status", "pending").order("created_at", { ascending: true });
  if (existingError) throw new Error("Could not load existing narrative memory.");
  const candidate = ((existingRows ?? []) as Record<string, unknown>[]).find(
    (row) => row.session_id !== input.sessionId && narrativeThemeSimilarity(row.content as string, content) >= SIMILARITY_THRESHOLD,
  );

  const { data: inserted, error: insertError } = await supabase
    .from("narrative_memories")
    .insert({ id: randomUUID(), student_id: input.studentId, session_id: input.sessionId, content, status: "pending" })
    .select()
    .single();
  if (insertError || !inserted) throw new Error("Could not record the narrative memory candidate.");
  const memory = toNarrativeMemory(inserted);

  let corroborated: NarrativeMemory | null = null;
  if (candidate) {
    const { data: confirmedRow, error: confirmError } = await supabase
      .from("narrative_memories")
      .update({ status: "confirmed", corroborated_by: memory.id })
      .eq("id", candidate.id as string)
      .select()
      .maybeSingle();
    if (confirmError) throw new Error("Could not confirm the corroborated narrative memory.");
    corroborated = confirmedRow ? toNarrativeMemory(confirmedRow) : null;
  }

  await enforceCaps(input.studentId, supabase);
  return { memory, corroborated };
}

/** §5.1's eviction rule: confirmed capped at 20, pending capped at 10, oldest evicted first. */
async function enforceCaps(studentId: string, supabase: SupabaseClient): Promise<void> {
  for (const [status, cap] of [
    ["confirmed", CONFIRMED_CAP],
    ["pending", PENDING_CAP],
  ] as const) {
    const { data, error } = await supabase.from("narrative_memories").select().eq("student_id", studentId).eq("status", status).order("created_at", { ascending: true });
    if (error) throw new Error("Could not check narrative memory capacity.");
    const rows = (data ?? []) as Record<string, unknown>[];
    const overflow = rows.length - cap;
    if (overflow <= 0) continue;
    for (const row of rows.slice(0, overflow)) {
      await supabase.from("narrative_memories").delete().eq("id", row.id as string);
    }
  }
}

/** Public read. Confirmed-only by default -- pending candidates are not yet trustworthy context for anything (§5.1). */
export async function listNarrativeMemories(studentId: string, options: { status?: NarrativeMemory["status"] } = { status: "confirmed" }, dependencies: MemoryDependencies = {}): Promise<NarrativeMemory[]> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  let query = supabase.from("narrative_memories").select().eq("student_id", studentId);
  if (options.status) query = query.eq("status", options.status);
  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) throw new Error("Could not load narrative memories.");
  return (data ?? []).map(toNarrativeMemory);
}

/**
 * The Step 24 retrieval contract: structured, bounded memory for a FUTURE pedagogy/personalized-RAG
 * consumer. Deterministic filters only (same subject/recent sessions) -- no vector embeddings for
 * learner memory (Step 25; the RAG vector DB is for source documents, not a second retrieval system
 * for this). NOT integrated into RAG in this phase -- nothing calls this from app/api/rag/route.ts.
 */
export async function getLearnerMemoryContext(query: LearnerMemoryContextQuery, dependencies: MemoryDependencies = {}): Promise<LearnerMemoryContext> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const limit = query.limit ?? DEFAULT_MEMORY_LIMIT;

  let sessionQuery = supabase.from("learning_sessions").select().eq("student_id", query.studentId).eq("status", "ended").order("started_at", { ascending: false });
  if (query.subject) sessionQuery = sessionQuery.eq("subject", query.subject);
  const { data: sessionRows, error: sessionError } = await sessionQuery;
  if (sessionError) throw new Error("Could not load session history for memory retrieval.");
  const candidateSessions = ((sessionRows ?? []) as Record<string, unknown>[]).slice(0, MAX_SESSIONS_SCANNED);

  const recentEpisodes = [];
  for (const row of candidateSessions) {
    if (recentEpisodes.length >= limit) break;
    const episode = await getSessionEpisode(row.id as string, { supabase });
    if (!episode || !episode.hasMeaningfulEvidence) continue; // Step 23: an empty session contributes no memory
    if (query.sessionId && episode.sessionId !== query.sessionId) continue;
    if (query.conceptId && !episode.conceptsTouched.includes(query.conceptId)) continue;
    recentEpisodes.push(episode);
  }

  const relevantNarratives = (await listNarrativeMemories(query.studentId, { status: "confirmed" }, { supabase })).slice(0, limit);
  const activeMisconceptions = await listMisconceptions(query.studentId, { conceptId: query.conceptId, status: "active" }, { supabase });
  const scaffolding = await getScaffoldingDecision(query.studentId, { supabase });

  return { studentId: query.studentId, recentEpisodes, relevantNarratives, activeMisconceptions, scaffolding };
}
