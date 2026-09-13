// §17.1's per-subject phase FSM (ARCHITECTURE.md, Phase 9). Module path matches the
// architecture's own canonical list exactly (§29: "phase.ts phase FSM (§17.1)").
//
// Three states, DIAGNOSTIC | INSTRUCTION | MAINTENANCE, stored on learner_ability (§27, migration
// 012) -- no new table. This file is the sole authoritative writer of `learner_ability.phase`
// (§32's table), exactly like bkt.ts/irt.ts/retention.ts each own their one column family.
//
// Pure transition function + impure resolver, the same split as everywhere else in this codebase.

import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { LEARNING_CONFIG } from "@/lib/learning/constants";
import { listConceptsBySubject } from "@/lib/learning/concepts";
import { getMasteryState } from "@/lib/learning/mastery";
import { getRetentionState } from "@/lib/learning/reviews";
import { calculateRetrievability, daysBetween } from "@/lib/learning/retention";
import { ensureAbilityRow, setPhase } from "@/lib/learning/ability";
import type { ConceptPhase } from "@/types/learning";

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

const MASTERY_ACHIEVED_THRESHOLD = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.MASTERY_ACHIEVED_THRESHOLD.value;
const RETENTION_ROUTING_THRESHOLD = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.RETENTION_ROUTING_THRESHOLD.value;

export interface ConceptPhaseSignal {
  conceptId: string;
  evidenceCount: number; // BKT evidence_count -- "has answered at least one question" proxy (§17.1's coverage rule)
  pMastery: number | null;
  stability: number | null;
  lastReviewedAt: string | null;
}

export interface PhaseDependencies {
  supabase?: SupabaseClient;
}

/**
 * §17.1's exact three transitions, pure. `concepts` is every concept currently registered under
 * the subject (Step: "hint-free question on every concept that appears in the currently selected
 * documents" -- documented simplification in types/learning.ts's ConceptPhase header: no
 * document<->concept mapping exists yet, so this evaluates every concept in the subject).
 * Zero concepts (a brand-new subject) never transitions -- there's nothing to evaluate coverage/
 * mastery/decay against, so the current phase (always DIAGNOSTIC for a never-touched row) holds.
 */
export function computePhaseTransition(current: ConceptPhase, concepts: ConceptPhaseSignal[], now: Date): ConceptPhase {
  if (concepts.length === 0) return current;

  if (current === "DIAGNOSTIC") {
    const coverageComplete = concepts.every((c) => c.evidenceCount >= 1);
    return coverageComplete ? "INSTRUCTION" : "DIAGNOSTIC";
  }

  if (current === "INSTRUCTION") {
    const allMastered = concepts.every((c) => c.pMastery !== null && c.pMastery >= MASTERY_ACHIEVED_THRESHOLD);
    return allMastered ? "MAINTENANCE" : "INSTRUCTION";
  }

  // MAINTENANCE -> INSTRUCTION: any *mastered* concept's retrievability has decayed below the
  // routing threshold. Non-mastered concepts can't even appear here (INSTRUCTION->MAINTENANCE
  // already required 100% mastery), but the guard is kept explicit rather than assumed.
  const anyDecayed = concepts.some((c) => {
    if (c.pMastery === null || c.pMastery < MASTERY_ACHIEVED_THRESHOLD) return false;
    if (c.stability === null || c.lastReviewedAt === null) return false;
    const retrievability = calculateRetrievability(daysBetween(new Date(c.lastReviewedAt), now), c.stability);
    return retrievability < RETENTION_ROUTING_THRESHOLD;
  });
  return anyDecayed ? "INSTRUCTION" : "MAINTENANCE";
}

/**
 * The DB-backed resolver: reads every concept-level signal the pure function needs, recomputes the
 * phase fresh, and persists a transition if one occurred (§17.1 recomputed on every next-activity
 * call, never cached beyond the persisted `phase` column itself). Read-only if no transition fires.
 */
export async function resolvePhase(studentId: string, subject: string, dependencies: PhaseDependencies & { now?: Date } = {}): Promise<ConceptPhase> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const now = dependencies.now ?? new Date();

  const ability = await ensureAbilityRow(studentId, subject, { supabase });
  const concepts = await listConceptsBySubject(subject, { supabase });
  if (concepts.length === 0) return ability.phase;

  const signals: ConceptPhaseSignal[] = await Promise.all(
    concepts.map(async (concept) => {
      const [mastery, retention] = await Promise.all([getMasteryState(studentId, concept.id, { supabase }), getRetentionState(studentId, concept.id, { supabase })]);
      return {
        conceptId: concept.id,
        evidenceCount: mastery?.evidenceCount ?? 0,
        pMastery: mastery?.pMastery ?? null,
        stability: retention?.stability ?? null,
        lastReviewedAt: retention?.lastReviewedAt ?? null,
      };
    }),
  );

  const nextPhase = computePhaseTransition(ability.phase, signals, now);
  if (nextPhase !== ability.phase) await setPhase(studentId, subject, nextPhase, now, { supabase });
  return nextPhase;
}
