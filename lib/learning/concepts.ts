import "server-only";
import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { LEARNING_CONFIG } from "@/lib/learning/constants";
import type {
  ConceptGraphEdge,
  ConceptGraphNode,
  ConceptReference,
  LearningConcept,
  PrerequisitePath,
  ResolvedConceptReference,
  StructuralPrerequisiteInfo,
} from "@/types/learning";

export class ConceptValidationError extends Error {}
export class ConceptCycleError extends Error {}

// Text-validation bounds (not LEARNING_CONFIG -- see lib/learning/profile.ts's identical
// reasoning: ARCHITECTURE.md §6A scopes that registry to the §7-§23 learner-intelligence
// algorithms, not plain input-length limits). MAX_PREREQUISITE_TRAVERSAL_DEPTH, by contrast, IS a
// product-policy safety bound on pedagogically-relevant graph traversal, so it lives in
// LEARNING_CONFIG (Step 13).
const MAX_CONCEPT_KEY_LENGTH = 80;
const MAX_SUBJECT_KEY_LENGTH = 60;
const MAX_DISPLAY_NAME_LENGTH = 120;
const MAX_TRAVERSAL_DEPTH = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.MAX_PREREQUISITE_TRAVERSAL_DEPTH.value;

// Retained verbatim from the Revision 1 design ARCHITECTURE.md §6 explicitly keeps ("that
// part was already correct and stays"): a small, fixed suffix list, not stemming or NLP, so
// "binary search algorithm" and "binary search" resolve to the same concept_key.
const GENERIC_SUFFIXES = [" algorithm", " technique", " method"];

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

// ---------------------------------------------------------------------------------------------
// Deterministic normalization (Step 6). Pure, no I/O -- the ONLY authority for concept/subject
// identity. Never fuzzy-matched, never LLM-assisted: two inputs are the same concept/subject if
// and only if they normalize to the same string.
// ---------------------------------------------------------------------------------------------

/**
 * Canonical concept identity (ARCHITECTURE.md §6's `concept_key` -- the task's "slug" is
 * this same column under the architecture's own name, not a second parallel field).
 * "Binary Search", "binary search", "binary-search", "binary_search", and "binary search algorithm"
 * all normalize to "binary-search". Semantically related but distinct concepts (e.g. "hash-table"
 * vs "hashing") are deliberately NEVER auto-merged by this function -- only exact post-normalization
 * string equality creates identity (Step 6).
 */
export function normalizeConceptKey(input: unknown): string {
  if (typeof input !== "string") throw new ConceptValidationError("A concept name must be text.");
  let value = input.trim().toLowerCase();
  for (const suffix of GENERIC_SUFFIXES) {
    if (value.endsWith(suffix)) {
      value = value.slice(0, -suffix.length).trim();
      break; // one strip only -- avoids over-eager stripping of legitimately compound names
    }
  }
  value = value.replace(/[^a-z0-9]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  if (!value) throw new ConceptValidationError("Concept name must contain at least one letter or digit.");
  if (value.length > MAX_CONCEPT_KEY_LENGTH) throw new ConceptValidationError(`Concept key must be ${MAX_CONCEPT_KEY_LENGTH} characters or fewer once normalized.`);
  return value;
}

/**
 * Canonical subject/domain identity (ARCHITECTURE.md §9.1's `subject` column, shared by
 * learner_ability, learning_concepts, and learning_sessions). Same normalization shape as concept
 * keys, without the generic-suffix stripping (a subject name has no equivalent "algorithm"/
 * "technique" filler to strip) -- "Data Structures", "data-structures", "DATA_STRUCTURES" all
 * normalize to "data-structures". Deliberately never derived from arbitrary free text at the point
 * a session starts (Step 5) -- every call site normalizes through this function first.
 */
export function normalizeSubjectKey(input: unknown): string {
  if (typeof input !== "string") throw new ConceptValidationError("A subject must be text.");
  const value = input.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  if (!value) throw new ConceptValidationError("Subject must contain at least one letter or digit.");
  if (value.length > MAX_SUBJECT_KEY_LENGTH) throw new ConceptValidationError(`Subject key must be ${MAX_SUBJECT_KEY_LENGTH} characters or fewer once normalized.`);
  return value;
}

// ---------------------------------------------------------------------------------------------
// Pure graph algorithms (Step 9, Step 12). Operate on plain edge arrays, no I/O -- callers pass
// in the full edge set already loaded from the database. This is the same "pure decision, impure
// orchestrator" split ARCHITECTURE.md §3/§17 uses throughout, and it's what makes the DAG
// invariants (Step 20's cycle/topological-order tests) testable without a database.
// ---------------------------------------------------------------------------------------------

function directPrerequisitesOf(edges: ConceptGraphEdge[], conceptId: string): string[] {
  return edges.filter((edge) => edge.conceptId === conceptId).map((edge) => edge.prerequisiteConceptId);
}

function directDependentsOf(edges: ConceptGraphEdge[], conceptId: string): string[] {
  return edges.filter((edge) => edge.prerequisiteConceptId === conceptId).map((edge) => edge.conceptId);
}

/**
 * Would adding "dependentId requires prerequisiteId" create a cycle? Mirrors Tutor MCP's
 * findPrereqCycle (ARCHITECTURE.md §36: ADAPT DIRECTLY) including its self-loop fast path.
 * A cycle exists iff prerequisiteId already (transitively) requires dependentId -- walk
 * prerequisiteId's own prerequisite chain looking for dependentId. Returns the full cycle path
 * (as it would exist after the new edge) for a readable error message, or null if safe to add.
 */
export function wouldCreateCycle(edges: ConceptGraphEdge[], dependentId: string, prerequisiteId: string): string[] | null {
  if (dependentId === prerequisiteId) return [dependentId, prerequisiteId];
  const visited = new Set<string>();
  function dfs(currentId: string, path: string[]): string[] | null {
    if (currentId === dependentId) return [...path, currentId];
    if (visited.has(currentId)) return null;
    visited.add(currentId);
    for (const next of directPrerequisitesOf(edges, currentId)) {
      const found = dfs(next, [...path, currentId]);
      if (found) return found;
    }
    return null;
  }
  const cyclePath = dfs(prerequisiteId, []);
  return cyclePath ? [...cyclePath, prerequisiteId] : null;
}

/** Transitive prerequisite closure (ancestors) -- everything conceptId ultimately depends on. */
export function getAncestorClosure(edges: ConceptGraphEdge[], conceptId: string, maxDepth = MAX_TRAVERSAL_DEPTH): Set<string> {
  const seen = new Set<string>();
  let frontier = directPrerequisitesOf(edges, conceptId);
  for (let depth = 0; frontier.length > 0 && depth < maxDepth; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      next.push(...directPrerequisitesOf(edges, id));
    }
    frontier = next;
  }
  return seen;
}

/** Transitive dependent closure (descendants) -- everything that ultimately requires conceptId. */
export function getDescendantClosure(edges: ConceptGraphEdge[], conceptId: string, maxDepth = MAX_TRAVERSAL_DEPTH): Set<string> {
  const seen = new Set<string>();
  let frontier = directDependentsOf(edges, conceptId);
  for (let depth = 0; frontier.length > 0 && depth < maxDepth; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      next.push(...directDependentsOf(edges, id));
    }
    frontier = next;
  }
  return seen;
}

/** Length of the longest prerequisite chain leading to conceptId (0 for a concept with none). */
export function computeDepth(edges: ConceptGraphEdge[], conceptId: string, maxDepth = MAX_TRAVERSAL_DEPTH): number {
  const direct = directPrerequisitesOf(edges, conceptId);
  if (direct.length === 0) return 0;
  let best = 0;
  for (const prereq of direct) {
    best = Math.max(best, 1 + computeDepth(edges, prereq, maxDepth - 1));
    if (best >= maxDepth) break;
  }
  return best;
}

/**
 * Deterministic topological order of everything targetId's prerequisite closure requires,
 * target excluded (Step 12's getPrerequisiteLearningOrder). Kahn's algorithm restricted to the
 * ancestor subgraph; when multiple concepts are simultaneously ready (no unprocessed
 * prerequisite), ties break by `keyOf` (alphabetical concept_key) -- the same deterministic
 * tie-break convention ARCHITECTURE.md §17.2 already uses for concept/action selection.
 */
export function computeTopologicalOrder(edges: ConceptGraphEdge[], targetId: string, keyOf: (id: string) => string): string[] {
  const ancestors = getAncestorClosure(edges, targetId);
  const subgraphEdges = edges.filter((edge) => ancestors.has(edge.conceptId) && ancestors.has(edge.prerequisiteConceptId));
  const remainingPrereqCount = new Map<string, number>();
  for (const id of ancestors) remainingPrereqCount.set(id, directPrerequisitesOf(subgraphEdges, id).length);

  const order: string[] = [];
  while (order.length < ancestors.size) {
    const ready = [...remainingPrereqCount.entries()].filter(([, count]) => count === 0).map(([id]) => id);
    if (ready.length === 0) break; // defensive: cycle prevention should make this unreachable
    ready.sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
    const next = ready[0];
    order.push(next);
    remainingPrereqCount.delete(next);
    for (const dependentId of directDependentsOf(subgraphEdges, next)) {
      const count = remainingPrereqCount.get(dependentId);
      if (count !== undefined) remainingPrereqCount.set(dependentId, count - 1);
    }
  }
  return order;
}

// ---------------------------------------------------------------------------------------------
// Database-backed registry (impure). Every write goes through here -- there is no other path
// that can insert a learning_concepts row or a concept_prerequisites edge (Step 10: "Do NOT
// expose unsafe raw graph mutations").
// ---------------------------------------------------------------------------------------------

function toConcept(row: Record<string, unknown>): LearningConcept {
  return {
    id: row.id as string,
    subject: row.subject as string,
    conceptKey: row.concept_key as string,
    displayName: row.display_name as string,
    aliases: Array.isArray(row.aliases) ? (row.aliases as string[]) : [],
    defaultPL0: (row.default_p_l0 as number | null) ?? null,
    defaultPT: (row.default_p_t as number | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function toGraphNode(concept: LearningConcept): ConceptGraphNode {
  return { id: concept.id, conceptKey: concept.conceptKey, displayName: concept.displayName, subject: concept.subject };
}

export interface ConceptDependencies {
  supabase?: SupabaseClient;
}

export async function getConcept(id: string, dependencies: ConceptDependencies = {}): Promise<LearningConcept | null> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const { data, error } = await supabase.from("learning_concepts").select().eq("id", id).maybeSingle();
  if (error) throw new Error("Could not load the concept.");
  return data ? toConcept(data) : null;
}

export async function getConceptByKey(conceptKey: string, dependencies: ConceptDependencies = {}): Promise<LearningConcept | null> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const { data, error } = await supabase.from("learning_concepts").select().eq("concept_key", conceptKey).maybeSingle();
  if (error) throw new Error("Could not load the concept.");
  return data ? toConcept(data) : null;
}

export async function listConcepts(dependencies: ConceptDependencies = {}): Promise<LearningConcept[]> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const { data, error } = await supabase.from("learning_concepts").select().order("subject").order("concept_key");
  if (error) throw new Error("Could not load concepts.");
  return (data ?? []).map(toConcept);
}

export async function listConceptsBySubject(subject: string, dependencies: ConceptDependencies = {}): Promise<LearningConcept[]> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const normalizedSubject = normalizeSubjectKey(subject);
  const { data, error } = await supabase.from("learning_concepts").select().eq("subject", normalizedSubject).order("concept_key");
  if (error) throw new Error("Could not load concepts for that subject.");
  return (data ?? []).map(toConcept);
}

/**
 * Creates a concept, or -- if a concept with the same normalized concept_key already exists --
 * returns it, appending the raw input string to `aliases` when it's a new surface form
 * (ARCHITECTURE.md §6/Revision 1: "insert-on-conflict by concept_key, append the raw input
 * to aliases if new"). This is the ONLY function that ever inserts into learning_concepts.
 */
export async function createOrResolveConcept(
  input: { subject: string; displayName: string },
  dependencies: ConceptDependencies = {},
): Promise<ResolvedConceptReference> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  if (typeof input.displayName !== "string" || !input.displayName.trim()) {
    throw new ConceptValidationError("Display name is required.");
  }
  if (input.displayName.trim().length > MAX_DISPLAY_NAME_LENGTH) {
    throw new ConceptValidationError(`Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.`);
  }
  const subject = normalizeSubjectKey(input.subject);
  const conceptKey = normalizeConceptKey(input.displayName);
  const rawDisplayName = input.displayName.trim();

  const existing = await getConceptByKey(conceptKey, { supabase });
  if (existing) {
    if (!existing.aliases.includes(rawDisplayName) && rawDisplayName !== existing.displayName) {
      const { data, error } = await supabase
        .from("learning_concepts")
        .update({ aliases: [...existing.aliases, rawDisplayName] })
        .eq("id", existing.id)
        .select()
        .single();
      if (error || !data) throw new Error("Could not record a new alias for the concept.");
      return { concept: toConcept(data), wasCreated: false };
    }
    return { concept: existing, wasCreated: false };
  }

  const { data, error } = await supabase
    .from("learning_concepts")
    .insert({ id: randomUUID(), subject, concept_key: conceptKey, display_name: rawDisplayName })
    .select()
    .single();
  if (error || !data) throw new Error("Could not create the concept.");
  return { concept: toConcept(data), wasCreated: true };
}

/**
 * Resolves a ConceptReference to an authoritative concept -- the one boundary a future
 * concept-extraction/quiz-generation step must call through (Step 15). A `{ subject, displayName }`
 * reference always passes through normalizeConceptKey()/normalizeSubjectKey() here; there is no
 * path that lets a caller (LLM-derived or otherwise) set an authoritative concept identity
 * without going through this normalization.
 */
export async function resolveConcept(reference: ConceptReference, dependencies: ConceptDependencies = {}): Promise<ResolvedConceptReference> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  if ("conceptId" in reference) {
    const concept = await getConcept(reference.conceptId, { supabase });
    if (!concept) throw new ConceptValidationError("Unknown concept id.");
    return { concept, wasCreated: false };
  }
  return createOrResolveConcept(reference, { supabase });
}

async function loadAllEdges(supabase: SupabaseClient): Promise<ConceptGraphEdge[]> {
  const { data, error } = await supabase.from("concept_prerequisites").select();
  if (error) throw new Error("Could not load the prerequisite graph.");
  return (data ?? []).map((row: Record<string, unknown>) => ({
    conceptId: row.concept_id as string,
    prerequisiteConceptId: row.prerequisite_concept_id as string,
  }));
}

/** Read-only cycle check, exposed on its own (Step 10) so a caller can validate before attempting a write. */
export async function checkWouldCreateCycle(conceptId: string, prerequisiteConceptId: string, dependencies: ConceptDependencies = {}): Promise<string[] | null> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const edges = await loadAllEdges(supabase);
  return wouldCreateCycle(edges, conceptId, prerequisiteConceptId);
}

/**
 * The only path that may insert a concept_prerequisites row (Step 10). Runs the DFS cycle check
 * (Step 9) before writing -- database writes go through this trusted service, never a raw insert.
 * Idempotent: re-adding an existing edge is a safe no-op, matching Step 8's "unique edge" +
 * general idempotent-friendly design used throughout this codebase.
 */
export async function addPrerequisite(conceptId: string, prerequisiteConceptId: string, dependencies: ConceptDependencies = {}): Promise<void> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  if (conceptId === prerequisiteConceptId) throw new ConceptCycleError(`A concept cannot be its own prerequisite: ${conceptId}`);

  const edges = await loadAllEdges(supabase);
  const alreadyExists = edges.some((edge) => edge.conceptId === conceptId && edge.prerequisiteConceptId === prerequisiteConceptId);
  if (alreadyExists) return;

  const cycle = wouldCreateCycle(edges, conceptId, prerequisiteConceptId);
  if (cycle) {
    // Resolve EVERY node in the path, not just the two endpoints of the new edge -- a cycle
    // through an intermediate concept (A -> B -> C, then attempting C -> A) must not leave B's id
    // unresolved in the error message.
    const uniqueIds = [...new Set(cycle)];
    const resolved = await Promise.all(uniqueIds.map((id) => getConcept(id, { supabase })));
    const labelById = new Map(uniqueIds.map((id, index) => [id, resolved[index]?.conceptKey ?? id]));
    const path = cycle.map((id) => labelById.get(id) ?? id).join(" → ");
    throw new ConceptCycleError(`Adding this prerequisite would create a cycle: ${path}`);
  }

  const { error } = await supabase.from("concept_prerequisites").insert({ concept_id: conceptId, prerequisite_concept_id: prerequisiteConceptId });
  if (error) throw new Error("Could not add the prerequisite relationship.");
}

export async function removePrerequisite(conceptId: string, prerequisiteConceptId: string, dependencies: ConceptDependencies = {}): Promise<void> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const { error } = await supabase.from("concept_prerequisites").delete().eq("concept_id", conceptId).eq("prerequisite_concept_id", prerequisiteConceptId);
  if (error) throw new Error("Could not remove the prerequisite relationship.");
}

export async function listPrerequisites(conceptId: string, dependencies: ConceptDependencies = {}): Promise<LearningConcept[]> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const edges = await loadAllEdges(supabase);
  const ids = directPrerequisitesOf(edges, conceptId);
  const concepts = await Promise.all(ids.map((id) => getConcept(id, { supabase })));
  return concepts.filter((c): c is LearningConcept => c !== null);
}

export async function listDependents(conceptId: string, dependencies: ConceptDependencies = {}): Promise<LearningConcept[]> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const edges = await loadAllEdges(supabase);
  const ids = directDependentsOf(edges, conceptId);
  const concepts = await Promise.all(ids.map((id) => getConcept(id, { supabase })));
  return concepts.filter((c): c is LearningConcept => c !== null);
}

export async function getPrerequisiteClosure(conceptId: string, dependencies: ConceptDependencies = {}): Promise<LearningConcept[]> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const edges = await loadAllEdges(supabase);
  const ids = [...getAncestorClosure(edges, conceptId)];
  const concepts = await Promise.all(ids.map((id) => getConcept(id, { supabase })));
  return concepts.filter((c): c is LearningConcept => c !== null);
}

export async function getDependentClosure(conceptId: string, dependencies: ConceptDependencies = {}): Promise<LearningConcept[]> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const edges = await loadAllEdges(supabase);
  const ids = [...getDescendantClosure(edges, conceptId)];
  const concepts = await Promise.all(ids.map((id) => getConcept(id, { supabase })));
  return concepts.filter((c): c is LearningConcept => c !== null);
}

/**
 * STRUCTURAL prerequisite info only -- deliberately not "readiness." Full readiness needs learner
 * mastery of each prerequisite (ARCHITECTURE.md §6's `isReadyFor`), which requires
 * learner_concept_state.p_mastery -- that table does not exist until Phase 3. There is
 * intentionally no `getLearnerReadiness`/`isReadyFor` function anywhere in this file (Step 11).
 */
export async function getStructuralPrerequisiteInfo(conceptId: string, dependencies: ConceptDependencies = {}): Promise<StructuralPrerequisiteInfo> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const edges = await loadAllEdges(supabase);
  const directIds = directPrerequisitesOf(edges, conceptId);
  const directConcepts = await Promise.all(directIds.map((id) => getConcept(id, { supabase })));
  return {
    conceptId,
    directPrerequisites: directConcepts.filter((c): c is LearningConcept => c !== null).map(toGraphNode),
    transitivePrerequisiteCount: getAncestorClosure(edges, conceptId).size,
    depth: computeDepth(edges, conceptId),
  };
}

/** Deterministic learning order for everything that must come before targetConceptId (Step 12). */
export async function getPrerequisiteLearningOrder(targetConceptId: string, dependencies: ConceptDependencies = {}): Promise<PrerequisitePath> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const edges = await loadAllEdges(supabase);
  const ancestorIds = [...getAncestorClosure(edges, targetConceptId)];
  const concepts = await Promise.all(ancestorIds.map((id) => getConcept(id, { supabase })));
  const byId = new Map(concepts.filter((c): c is LearningConcept => c !== null).map((c) => [c.id, c]));
  const orderedIds = computeTopologicalOrder(edges, targetConceptId, (id) => byId.get(id)?.conceptKey ?? id);
  return { targetConceptId, order: orderedIds.map((id) => byId.get(id)).filter((c): c is LearningConcept => c !== undefined).map(toGraphNode) };
}
