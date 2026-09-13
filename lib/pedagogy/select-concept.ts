// §17.2's phase-dispatched concept selection + priority overrides (ARCHITECTURE.md, Phase
// 9). Module path matches the architecture's own canonical list exactly (§29: "select-concept.ts
// phase-dispatched concept selection + priority overrides (§17.2)").
//
// Pure `selectConcept()` + impure `buildConceptCandidates()`/`resolveConceptSelection()`, the same
// split used by every other decision engine in this codebase (select-action.ts, phase.ts).
//
// Documented simplification (see types/learning.ts's ConceptPhase header comment): relevance(c) =
// 1.0 uniformly for every concept in the requested subject -- no document<->concept mapping exists
// in the schema yet (Phase 10's concern), so the "in the currently selected documents" term of
// §17.2's formulas always evaluates to its own 1.0 branch.

import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { LEARNING_CONFIG } from "@/lib/learning/constants";
import { listConceptsBySubject } from "@/lib/learning/concepts";
import { getMasteryState } from "@/lib/learning/mastery";
import { getRetentionState } from "@/lib/learning/reviews";
import { calculateRetrievability, daysBetween } from "@/lib/learning/retention";
import { getPrerequisiteReadiness } from "@/lib/learning/readiness";
import { listMisconceptions } from "@/lib/learning/misconceptions";
import type { ConceptPhase, ConceptSelectionResult } from "@/types/learning";

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

const MASTERY_ACHIEVED_THRESHOLD = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.MASTERY_ACHIEVED_THRESHOLD.value;
const RETENTION_CRITICAL = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.RETENTION_URGENCY_CRITICAL_MAX.value;
const RELEVANCE_IN_SCOPE = 1.0; // documented simplification above -- every concept in-subject is treated as in-scope

export interface ConceptCandidateSignal {
  conceptId: string;
  conceptKey: string;
  displayName: string;
  evidenceCount: number;
  pMastery: number | null;
  stability: number | null;
  lastReviewedAt: string | null;
  readinessReady: boolean; // §6 -- every direct prerequisite ready/ready_but_review_due
  hasActiveMisconception: boolean;
}

export interface ConceptDependencies {
  supabase?: SupabaseClient;
}

function retrievabilityOf(signal: ConceptCandidateSignal, now: Date): number | null {
  if (signal.stability === null || signal.lastReviewedAt === null) return null;
  return calculateRetrievability(daysBetween(new Date(signal.lastReviewedAt), now), signal.stability);
}

/**
 * §17.2's exact cascade, pure: priority overrides first (retention-critical bypass, active-
 * misconception priority), then the phase-dispatched formula over whatever anti-repeat leaves.
 * Tie-breaks are always alphabetical by `conceptKey` (deterministic, a direct port per §17.2).
 */
export function selectConcept(phase: ConceptPhase, candidates: ConceptCandidateSignal[], lastSelectedConceptId: string | null, now: Date): ConceptSelectionResult {
  if (candidates.length === 0) {
    return { conceptId: null, conceptKey: null, displayName: null, reasonCode: "NO_CONCEPTS_AVAILABLE" };
  }

  const byKey = (a: ConceptCandidateSignal, b: ConceptCandidateSignal) => a.conceptKey.localeCompare(b.conceptKey);

  // Override 1: retrievability < RETENTION_CRITICAL on ANY concept force-selects it, overriding
  // the phase formula and anti-repeat entirely. Deterministic tie-break: most-decayed first, then
  // alphabetical.
  const critical = candidates.filter((c) => {
    const r = retrievabilityOf(c, now);
    return r !== null && r < RETENTION_CRITICAL;
  });
  if (critical.length > 0) {
    const chosen = [...critical].sort((a, b) => (retrievabilityOf(a, now)! - retrievabilityOf(b, now)!) || byKey(a, b))[0];
    return { conceptId: chosen.conceptId, conceptKey: chosen.conceptKey, displayName: chosen.displayName, reasonCode: "PRIORITY_RETENTION_CRITICAL" };
  }

  // Override 2: any concept with an active misconception is never excluded by anti-repeat and is
  // prioritized above the ordinary phase formula.
  const withMisconception = candidates.filter((c) => c.hasActiveMisconception);
  if (withMisconception.length > 0) {
    const chosen = [...withMisconception].sort(byKey)[0];
    return { conceptId: chosen.conceptId, conceptKey: chosen.conceptKey, displayName: chosen.displayName, reasonCode: "PRIORITY_ACTIVE_MISCONCEPTION" };
  }

  // Override 3: anti-repeat -- exclude the immediately-previous selection, unless doing so would
  // empty the pool (a 1-concept subject must still produce a selection every time).
  const antiRepeatPool = candidates.length > 1 ? candidates.filter((c) => c.conceptId !== lastSelectedConceptId) : candidates;
  const pool = antiRepeatPool.length > 0 ? antiRepeatPool : candidates;

  if (phase === "DIAGNOSTIC") {
    const chosen = [...pool].sort((a, b) => a.evidenceCount - b.evidenceCount || byKey(a, b))[0];
    return { conceptId: chosen.conceptId, conceptKey: chosen.conceptKey, displayName: chosen.displayName, reasonCode: "PHASE_DIAGNOSTIC_LEAST_EVIDENCE" };
  }

  if (phase === "INSTRUCTION") {
    const ready = pool.filter((c) => c.readinessReady);
    const scored = (ready.length > 0 ? ready : pool).map((c) => ({ c, score: RELEVANCE_IN_SCOPE * (1 - (c.pMastery ?? 0)) }));
    const chosen = scored.sort((a, b) => b.score - a.score || byKey(a.c, b.c))[0].c;
    return { conceptId: chosen.conceptId, conceptKey: chosen.conceptKey, displayName: chosen.displayName, reasonCode: "PHASE_INSTRUCTION_ARGMAX" };
  }

  // MAINTENANCE
  const mastered = pool.filter((c) => c.pMastery !== null && c.pMastery >= MASTERY_ACHIEVED_THRESHOLD);
  if (mastered.length === 0) {
    // Safety fallback (documented, mirrors select-action.ts's "the cascade must always produce
    // exactly one" principle): a MAINTENANCE subject with no mastered concept left in the pool
    // (e.g. every mastered concept was just anti-repeat-excluded) falls back to least-evidence-first
    // over the whole pool rather than returning nothing.
    const chosen = [...pool].sort((a, b) => a.evidenceCount - b.evidenceCount || byKey(a, b))[0];
    return { conceptId: chosen.conceptId, conceptKey: chosen.conceptKey, displayName: chosen.displayName, reasonCode: "PHASE_DIAGNOSTIC_LEAST_EVIDENCE" };
  }
  const scored = mastered.map((c) => ({ c, score: (1 - (retrievabilityOf(c, now) ?? 1)) * RELEVANCE_IN_SCOPE }));
  const chosen = scored.sort((a, b) => b.score - a.score || byKey(a.c, b.c))[0].c;
  return { conceptId: chosen.conceptId, conceptKey: chosen.conceptKey, displayName: chosen.displayName, reasonCode: "PHASE_MAINTENANCE_ARGMAX" };
}

/** Gathers every signal `selectConcept()` needs for every concept in `subject`. Read-only. */
export async function buildConceptCandidates(studentId: string, subject: string, dependencies: ConceptDependencies = {}): Promise<ConceptCandidateSignal[]> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const concepts = await listConceptsBySubject(subject, { supabase });

  return Promise.all(
    concepts.map(async (concept) => {
      const [mastery, retention, readiness, activeMisconceptions] = await Promise.all([
        getMasteryState(studentId, concept.id, { supabase }),
        getRetentionState(studentId, concept.id, { supabase }),
        getPrerequisiteReadiness(studentId, concept.id, { supabase }),
        listMisconceptions(studentId, { conceptId: concept.id, status: "active" }, { supabase }),
      ]);
      return {
        conceptId: concept.id,
        conceptKey: concept.conceptKey,
        displayName: concept.displayName,
        evidenceCount: mastery?.evidenceCount ?? 0,
        pMastery: mastery?.pMastery ?? null,
        stability: retention?.stability ?? null,
        lastReviewedAt: retention?.lastReviewedAt ?? null,
        readinessReady: readiness.ready,
        hasActiveMisconception: activeMisconceptions.length > 0,
      };
    }),
  );
}
