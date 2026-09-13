// Revision recommendations (ARCHITECTURE.md §23, Phase 11). Module path matches the
// architecture's own exact module list (§29: "recommendations.ts ranking (§23)").
//
// Answers "what should this learner revise next, and why" -- a BROADER, cross-concept ordering
// question, deliberately distinct from Phase 8's `lib/pedagogy/select-action.ts` (Step 17: "next
// pedagogical action for a target/current context" vs. "revision ordering across concepts/
// subjects"). Neither duplicates the other: this file never imports select-action.ts, and its own
// "transfer practice" criterion is intentionally a simpler, more permissive analytics-level read
// (mastered + transfer not ready) than Phase 8's stricter TRANSFER_CHALLENGE eligibility gate
// (which additionally requires "diverse evidence" -- a pedagogical-action-selection concern, not a
// descriptive-analytics one).
//
// §23's own formula is used VERBATIM (Step 19's "no score soup" rule explicitly excepts a formula
// the architecture itself locked) -- this is the one place in the whole learner-intelligence
// subsystem outside BKT/IRT/FSRS's own published formulas where a weighted sum is correct, because
// it is the architecture's own literal, cited design, not an invented one.

import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { LEARNING_CONFIG } from "@/lib/learning/constants";
import { listConcepts, listConceptsBySubject } from "@/lib/learning/concepts";
import { getMasteryState, getPracticeSignal } from "@/lib/learning/mastery";
import { getRetentionState } from "@/lib/learning/reviews";
import { calculateRetrievability, daysBetween, getRetentionUrgency } from "@/lib/learning/retention";
import { listMisconceptions } from "@/lib/learning/misconceptions";
import { getTransferSignal } from "@/lib/learning/transfer";
import { getPrerequisiteReadiness } from "@/lib/learning/readiness";
import type { CardState, RetentionUrgencyLevel } from "@/types/learning";

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

const MASTERY_ACHIEVED_THRESHOLD = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.MASTERY_ACHIEVED_THRESHOLD.value;
const DEFAULT_LIMIT = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.REVISION_RECOMMENDATIONS_DEFAULT_LIMIT.value;
const MAX_LIMIT = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.REVISION_RECOMMENDATIONS_MAX_LIMIT.value;
// §22's own documented simplification, reused verbatim here for §23's identical relevance(concept)
// term: no document<->concept mapping exists in the schema yet (Phase 10's own note; building it
// is Phase-10-and-beyond's "personalized RAG integration" territory, not this file's job).
const RELEVANCE_IN_SCOPE = 1.0;

export type RevisionReasonCode = "MASTERY_DEVELOPING" | "REVIEW_DUE" | "ACTIVE_MISCONCEPTION" | "PRACTICE_PLATEAU" | "PREREQUISITE_BLOCKER" | "TRANSFER_NOT_DEMONSTRATED";

export interface RevisionCandidateSignal {
  conceptId: string;
  conceptKey: string;
  displayName: string;
  subject: string;
  evidenceCount: number;
  pMastery: number | null;
  cardState: CardState | null; // carried alongside retentionUrgencyLevel so a caller can derive an OLM stage (lib/learning/olm.ts) without a second retention query
  retrievability: number | null;
  retentionUrgencyLevel: RetentionUrgencyLevel | null;
  misconceptionActive: boolean;
  pfaPlateaued: boolean;
}

function retentionUrgencyScore(level: RetentionUrgencyLevel | null): number {
  if (level === "critical") return 1.0;
  if (level === "warning") return 0.5;
  return 0;
}

/** §23's exact weighted formula. `evidence_count === 0` is excluded entirely -- "still excluded entirely (nothing observed yet), exactly as Revision 1 specified" -- returns null, never merely ranked last. */
export function computeRevisionPriority(signal: RevisionCandidateSignal): number | null {
  if (signal.evidenceCount === 0) return null;
  const mastery = signal.pMastery ?? 0;
  return 0.35 * (1 - mastery) + 0.25 * retentionUrgencyScore(signal.retentionUrgencyLevel) + 0.2 * (signal.misconceptionActive ? 1 : 0) + 0.1 * (signal.pfaPlateaued ? 1 : 0) + 0.1 * RELEVANCE_IN_SCOPE;
}

/**
 * Deterministic reason codes, one per §23 term that actually fired for this candidate -- not
 * itself a literal token the architecture names (§23 has no numbered rows the way §17.3 does), so
 * this is this phase's own deterministic naming, kept 1:1 with which raw signal contributed,
 * exactly the same convention Phase 8's `PedagogicalReasonCode` established for its own cascade.
 */
export function deriveRevisionReasonCodes(signal: RevisionCandidateSignal): RevisionReasonCode[] {
  const codes: RevisionReasonCode[] = [];
  if (signal.pMastery === null || signal.pMastery < MASTERY_ACHIEVED_THRESHOLD) codes.push("MASTERY_DEVELOPING");
  if (signal.retentionUrgencyLevel === "warning" || signal.retentionUrgencyLevel === "critical") codes.push("REVIEW_DUE");
  if (signal.misconceptionActive) codes.push("ACTIVE_MISCONCEPTION");
  if (signal.pfaPlateaued) codes.push("PRACTICE_PLATEAU");
  return codes;
}

/** §23's exact output template: "Review **{displayName}** — mastery {round(p_mastery*100)}%, {status line}." One status phrase per the highest-priority reason present, deterministic. */
export function formatRevisionSummary(displayName: string, pMastery: number | null, reasonCodes: RevisionReasonCode[]): string {
  const masteryPercent = Math.round((pMastery ?? 0) * 100);
  const statusOrder: Record<RevisionReasonCode, string> = {
    REVIEW_DUE: "retention has dropped since last practiced",
    ACTIVE_MISCONCEPTION: "a recurring error pattern is still active",
    PRACTICE_PLATEAU: "recent practice has plateaued",
    MASTERY_DEVELOPING: "still building mastery",
    PREREQUISITE_BLOCKER: "a prerequisite needs attention first",
    TRANSFER_NOT_DEMONSTRATED: "not yet applied in a new context",
  };
  const status = reasonCodes.map((code) => statusOrder[code]).find(Boolean) ?? "still building mastery";
  return `Review **${displayName}** — mastery ${masteryPercent}%, ${status}.`;
}

export interface RevisionRecommendation {
  conceptId: string;
  conceptKey: string;
  displayName: string;
  subject: string;
  priority: number;
  reasonCodes: RevisionReasonCode[];
  summary: string;
  // See types/progress.ts's mirror of this field for the full rationale (Week 4 hardening: fixes the
  // Progress -> Intervention mismatch). Self for an ordinary candidate; the ORIGINAL blocked target's
  // conceptKey for a row inserted by the prerequisite-substitution step below.
  interventionConceptKey: string;
}

/** Ranks candidates by priority desc, alphabetical conceptKey tie-break -- the same determinism convention as every other ranking function in this codebase. */
export function rankRevisionCandidates(signals: RevisionCandidateSignal[]): RevisionRecommendation[] {
  return signals
    .map((signal) => ({ signal, priority: computeRevisionPriority(signal) }))
    .filter((entry): entry is { signal: RevisionCandidateSignal; priority: number } => entry.priority !== null)
    .sort((a, b) => b.priority - a.priority || a.signal.conceptKey.localeCompare(b.signal.conceptKey))
    .map(({ signal, priority }) => ({
      conceptId: signal.conceptId,
      conceptKey: signal.conceptKey,
      displayName: signal.displayName,
      subject: signal.subject,
      priority,
      reasonCodes: deriveRevisionReasonCodes(signal),
      summary: formatRevisionSummary(signal.displayName, signal.pMastery, deriveRevisionReasonCodes(signal)),
      interventionConceptKey: signal.conceptKey, // ordinary candidate: recovery targets this same concept
    }));
}

/**
 * Step 21: "If concept C is weak because prerequisite B is blocking it, recommend B before C ...
 * do not let a dependent concept rank ahead of a required blocking prerequisite." A stable
 * insertion pass, not a priority-score hack -- guarantees the ordering invariant regardless of how
 * close/tied the raw scores are. A blocker not already in the ranked pool (e.g. zero evidence of
 * its own) is still inserted, tagged PREREQUISITE_BLOCKER, using the blocked concept's own priority
 * as a floor (fixing the blocker is at least as urgent as the concept it blocks).
 */
function enforcePrerequisiteOrder(items: RevisionRecommendation[], blockerMap: Map<string, RevisionRecommendation[]>): RevisionRecommendation[] {
  const result: RevisionRecommendation[] = [];
  const inserted = new Set<string>();
  for (const item of items) {
    for (const blocker of blockerMap.get(item.conceptId) ?? []) {
      if (inserted.has(blocker.conceptId)) continue;
      result.push(blocker);
      inserted.add(blocker.conceptId);
    }
    if (!inserted.has(item.conceptId)) {
      result.push(item);
      inserted.add(item.conceptId);
    }
  }
  return result;
}

/** Exported so other callers (e.g. lib/personalization/prompt-context.ts's own weak-concept ranking, §22) can reuse this gathering step rather than re-implementing it. */
export async function buildRevisionCandidateSignal(studentId: string, concept: { id: string; conceptKey: string; displayName: string; subject: string }, now: Date, dependencies: RecommendationsDependencies = {}): Promise<RevisionCandidateSignal> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  return buildCandidateSignal(studentId, concept, now, supabase);
}

async function buildCandidateSignal(studentId: string, concept: { id: string; conceptKey: string; displayName: string; subject: string }, now: Date, supabase: SupabaseClient): Promise<RevisionCandidateSignal> {
  const [mastery, retention, activeMisconceptions, practice] = await Promise.all([
    getMasteryState(studentId, concept.id, { supabase }),
    getRetentionState(studentId, concept.id, { supabase }),
    listMisconceptions(studentId, { conceptId: concept.id, status: "active" }, { supabase }),
    getPracticeSignal(studentId, concept.id, { supabase }),
  ]);

  let retentionUrgencyLevel: RetentionUrgencyLevel | null = null;
  let retrievability: number | null = null;
  if (retention?.stability !== null && retention?.stability !== undefined && retention.lastReviewedAt) {
    retrievability = calculateRetrievability(daysBetween(new Date(retention.lastReviewedAt), now), retention.stability);
    retentionUrgencyLevel = getRetentionUrgency(retrievability).level;
  }

  return {
    conceptId: concept.id,
    conceptKey: concept.conceptKey,
    displayName: concept.displayName,
    subject: concept.subject,
    evidenceCount: mastery?.evidenceCount ?? 0,
    pMastery: mastery?.pMastery ?? null,
    cardState: retention?.cardState ?? null,
    retrievability,
    retentionUrgencyLevel,
    misconceptionActive: activeMisconceptions.length > 0,
    pfaPlateaued: practice.plateaued,
  };
}

export interface RevisionRecommendationsOptions {
  subject?: string;
  limit?: number;
}

export interface RevisionRecommendationsResult {
  recommendations: RevisionRecommendation[]; // §23's priority-ranked list, prerequisite order enforced, bounded
  transferPractice: RevisionRecommendation[]; // additive: mastered concepts whose transfer isn't yet demonstrated (Step 15) -- §23's own formula has no transfer term, so this is a separate category, never blended into the same score
}

export interface RecommendationsDependencies {
  supabase?: SupabaseClient;
  now?: Date;
}

/**
 * The Step 17/23 entry point. Bounded (Step 23: "do not return every concept in the database"),
 * read-only (Step 39: no write path exists anywhere in this file), never persisted (§23: "still
 * not persisted -- computed on demand").
 */
export async function getRevisionRecommendations(studentId: string, options: RevisionRecommendationsOptions = {}, dependencies: RecommendationsDependencies = {}): Promise<RevisionRecommendationsResult> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const now = dependencies.now ?? new Date();
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  const concepts = options.subject ? await listConceptsBySubject(options.subject, { supabase }) : await listConcepts({ supabase });

  const signals = await Promise.all(concepts.map((concept) => buildCandidateSignal(studentId, concept, now, supabase)));
  const ranked = rankRevisionCandidates(signals);

  // Prerequisite substitution (Step 21): for every ranked candidate that is itself blocked, gather
  // its unready blockers (Phase 2's own deterministic remediation order, reused verbatim) as
  // additional recommendation entries.
  // Every item's readiness/blocker-signal lookups are independent of every other item's (each is
  // keyed only by studentId + that item's own conceptId/blockers, and blockerMap is a plain Map
  // keyed by conceptId), so this is the same safe, order-preserving Promise.all pattern already
  // used above for `signals` -- a pure I/O latency win, not a semantic change.
  const blockerMap = new Map<string, RevisionRecommendation[]>();
  const blockerEntriesByItem = await Promise.all(
    ranked.map(async (item) => {
      const readiness = await getPrerequisiteReadiness(studentId, item.conceptId, { supabase });
      if (readiness.ready || readiness.blockers.length === 0) return null;
      const blockerEntries = await Promise.all(
        readiness.blockers.map(async (blocker) => {
          const blockerSignal = await buildCandidateSignal(studentId, { id: blocker.conceptId, conceptKey: blocker.conceptKey, displayName: blocker.displayName, subject: item.subject }, now, supabase);
          const naturalPriority = computeRevisionPriority(blockerSignal);
          const priority = Math.max(naturalPriority ?? 0, item.priority);
          const reasonCodes: RevisionReasonCode[] = ["PREREQUISITE_BLOCKER", ...deriveRevisionReasonCodes(blockerSignal).filter((c) => c !== "PREREQUISITE_BLOCKER")];
          // Root-cause fix (Week 4 hardening): this row displays the BLOCKER's own identity, but a
          // "Start Recovery" action on it must invoke detectIntervention() on `item` (the concept
          // this blocker is actually blocking) -- that is the only concept whose PREREQUISITE_GAP
          // trigger this blocker relationship corresponds to. Invoking it on the blocker's own
          // conceptId instead asks detectIntervention() an unrelated question ("are THIS concept's
          // own prerequisites ready") and, for a blocker with no evidence of its own, reliably comes
          // back NOT_NEEDED even though Progress just showed "Start Recovery" for it.
          return { conceptId: blocker.conceptId, conceptKey: blocker.conceptKey, displayName: blocker.displayName, subject: item.subject, priority, reasonCodes, summary: formatRevisionSummary(blocker.displayName, blockerSignal.pMastery, reasonCodes), interventionConceptKey: item.conceptKey };
        }),
      );
      return { conceptId: item.conceptId, blockerEntries };
    }),
  );
  for (const entry of blockerEntriesByItem) {
    if (entry) blockerMap.set(entry.conceptId, entry.blockerEntries);
  }

  const ordered = enforcePrerequisiteOrder(ranked, blockerMap);
  const recommendations = ordered.slice(0, limit);

  // Transfer-practice: additive, not part of the §23-ranked list (its formula has no transfer
  // term) -- mastered concepts whose transfer isn't yet demonstrated (Step 15). Deliberately a
  // simpler, analytics-level read than Phase 8's stricter TRANSFER_CHALLENGE eligibility gate.
  const transferCandidates = await Promise.all(
    signals
      .filter((s) => s.pMastery !== null && s.pMastery >= MASTERY_ACHIEVED_THRESHOLD)
      .map(async (s) => {
        const transfer = await getTransferSignal(studentId, s.conceptId, { supabase });
        if (transfer.readiness === "ready") return null;
        const reasonCodes: RevisionReasonCode[] = ["TRANSFER_NOT_DEMONSTRATED"];
        return { conceptId: s.conceptId, conceptKey: s.conceptKey, displayName: s.displayName, subject: s.subject, priority: 1 - (s.pMastery ?? 1), reasonCodes, summary: formatRevisionSummary(s.displayName, s.pMastery, reasonCodes), interventionConceptKey: s.conceptKey } as RevisionRecommendation;
      }),
  );
  const transferPractice = transferCandidates
    .filter((r): r is RevisionRecommendation => r !== null)
    .sort((a, b) => a.conceptKey.localeCompare(b.conceptKey))
    .slice(0, limit);

  return { recommendations, transferPractice };
}
