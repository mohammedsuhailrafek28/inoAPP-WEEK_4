// Open Learner Model presentation stages (ARCHITECTURE.md §30.2/§30.3, Decision 3 LOCKED).
// Module path matches the architecture's own exact module list (§29: "olm.ts
// deriveMasteryStage() / explainConceptStatus() -- pure, zero Gemini calls, the sole source for
// §30's Progress panel").
//
// Phase 10 built only `deriveMasteryStage()` (the six-stage vocabulary, needed to label concepts
// qualitatively inside the bounded RAG personalization context). Phase 11 adds
// `explainConceptStatus()` (§30.3's template-based "why" bullets) and `getConceptStatus()` (the
// DB-backed composer analytics/progress reporting actually needs -- Step 25's "concept summary":
// stage + why + review status + gated transfer/misconception visibility) -- this phase's own
// Progress-service responsibility (Step 32: "Do not scatter stage derivation across APIs"), still
// explicitly NOT the Progress panel UI itself ("DO NOT IMPLEMENT YET: final dashboard UI").
//
// This file still makes zero Gemini calls, directly or indirectly -- `explainConceptStatus()` is
// template-based exactly as §30.3/Step 9-10 require, never a generated interpretation.

import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { LEARNING_CONFIG } from "@/lib/learning/constants";
import { getConcept } from "@/lib/learning/concepts";
import { getMasteryState } from "@/lib/learning/mastery";
import { getRetentionState } from "@/lib/learning/reviews";
import { calculateRetrievability, daysBetween, getReviewStatus, getRetentionUrgency } from "@/lib/learning/retention";
import { listMisconceptions } from "@/lib/learning/misconceptions";
import { getTransferSignal } from "@/lib/learning/transfer";
import type { CardState, ReviewStatus, TransferReadiness } from "@/types/learning";

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

const MIN_EVIDENCE_FOR_ADAPTIVE = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.MIN_EVIDENCE_FOR_ADAPTIVE.value;
const MASTERY_READY_THRESHOLD = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.MASTERY_READY_THRESHOLD.value;
const MASTERY_ACHIEVED_THRESHOLD = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.MASTERY_ACHIEVED_THRESHOLD.value;
const OLM_REVIEW_DUE_MAX = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.OLM_REVIEW_DUE_MAX.value;

export const MASTERY_STAGES = ["NEW", "LEARNING", "DEVELOPING", "PROFICIENT", "MASTERED", "REVIEW_DUE"] as const;
export type MasteryStage = (typeof MASTERY_STAGES)[number];

export interface MasteryStageInput {
  evidenceCount: number;
  pMastery: number | null;
  cardState: CardState | null; // null when no retention row exists yet (never reviewed)
  retrievability: number | null; // caller-computed via calculateRetrievability(daysBetween(lastReviewedAt, now), stability); null when cardState is null/'new'
}

/**
 * §30.2's exact six-stage function, pure and total (every valid input maps to exactly one stage).
 * `REVIEW_DUE` overrides every mastery-based stage below it, per the architecture's own explicit
 * ordering note -- checked second, right after the `NEW` gate.
 */
export function deriveMasteryStage(input: MasteryStageInput): MasteryStage {
  if (input.evidenceCount === 0) return "NEW";

  if (input.cardState !== null && input.cardState !== "new" && input.retrievability !== null && input.retrievability < OLM_REVIEW_DUE_MAX) {
    return "REVIEW_DUE";
  }

  const evidenceSufficient = input.evidenceCount >= MIN_EVIDENCE_FOR_ADAPTIVE;
  if (!evidenceSufficient || input.pMastery === null || input.pMastery < 0.4) return "LEARNING";
  if (input.pMastery < MASTERY_READY_THRESHOLD) return "DEVELOPING";
  if (input.pMastery < MASTERY_ACHIEVED_THRESHOLD) return "PROFICIENT";
  return "MASTERED";
}

export interface ExplainConceptStatusInput {
  stage: MasteryStage;
  evidenceCount: number;
  activeMisconception: { description: string; evidenceCount: number } | null; // status='active' only -- never a candidate (§30.4)
  retentionUrgencyLevel: "ok" | "warning" | "critical" | null; // null when no retention state exists yet
  transferReadiness: TransferReadiness | null; // null when transfer_attempts === 0 (§30.4: no line at all, never a misleading "N/A")
}

/**
 * §30.3's exact template-based "why," pure, zero Gemini calls (Step 9/10: "Do NOT use Gemini to
 * decide why a stage was assigned... implement deterministic templates keyed by reason codes/
 * state"). Reproduces the architecture's own worked example ("Rabin-Karp -- Developing: 3 practice
 * attempts / 2 recent errors involving rolling hash / Review recommended") verbatim.
 *
 * Resolved ambiguity: §30.3's own worked example shows "Review recommended" on a DEVELOPING-stage
 * concept, but §30.3's literal gating text says this line fires "only when stage == REVIEW_DUE" --
 * a real internal inconsistency in the locked doc (REVIEW_DUE, per §30.2, additionally requires
 * retrievability < 0.40, strictly narrower than merely being retention-urgent). Resolved by gating
 * on retention URGENCY (§10.3's own WARNING/CRITICAL tiers, already locked, reused verbatim) rather
 * than on the STAGE label -- the strictly broader, worked-example-reproducing reading, and the one
 * that reuses an existing signal rather than inventing a new threshold. Same "hand-check against
 * the doc's own worked example before coding" pattern applied in Phases 3/4/5.
 */
export function explainConceptStatus(input: ExplainConceptStatusInput): string[] {
  if (input.stage === "NEW") return ["Not yet studied"];

  const lines: string[] = [];
  if (input.evidenceCount > 0) lines.push(`${input.evidenceCount} practice attempt${input.evidenceCount === 1 ? "" : "s"}`);
  if (input.activeMisconception) {
    const n = input.activeMisconception.evidenceCount;
    lines.push(`${n} recent error${n === 1 ? "" : "s"} involving ${input.activeMisconception.description}`);
  }
  if (input.retentionUrgencyLevel === "warning" || input.retentionUrgencyLevel === "critical") {
    lines.push("Review recommended -- retention has dropped since last practiced");
  }
  if (input.transferReadiness === "ready") lines.push("Successfully applied in a new context");

  return lines.slice(0, 3); // §30.3: "paired with 1-3 short factual bullet lines"
}

export interface ConceptStatus {
  conceptId: string;
  conceptKey: string;
  displayName: string;
  subject: string;
  stage: MasteryStage;
  why: string[];
  evidenceCount: number;
  reviewStatus: ReviewStatus | null; // null when no retention state exists yet
  // §10.3's real 3-tier urgency (ok/warning/critical) -- a qualitative tier label, not a raw
  // retrievability float, so exposing it doesn't reintroduce "raw internals" (Step 8/42). Distinct
  // from `stage === 'REVIEW_DUE'`: REVIEW_DUE uses its own §30.2 threshold (0.40), narrower than
  // §10.3's "warning" band (0.30-0.50) -- a concept can be retention-"warning" while its OLM stage
  // is still e.g. DEVELOPING. Kept here (rather than only inside olm.ts's own `why` computation)
  // so analytics.ts's §24 "count by urgency tier" metric can use the REAL tiers, not approximate
  // them from `stage`.
  retentionUrgencyLevel: "ok" | "warning" | "critical" | null; // null when no retention state exists yet
  // §30.4's evidence gates, enforced structurally: a field is null/absent rather than merely
  // "empty" whenever its own gate (>=1 transfer attempt; status==='active') isn't met, so a caller
  // can never accidentally render a misleading placeholder for ungated data.
  transferReadiness: TransferReadiness | null; // null unless transfer_attempts >= 1 (§30.4)
  activeMisconception: { tag: string; description: string; evidenceCount: number } | null; // status='active' only
}

export interface ConceptStatusDependencies {
  supabase?: SupabaseClient;
  now?: Date;
}

/**
 * The Step 25/32 "concept summary" entry point -- the one place stage derivation, gated
 * visibility, and the deterministic "why" are composed together, so no API route recomputes any
 * of this itself. Entirely read-only.
 */
export async function getConceptStatus(studentId: string, conceptId: string, dependencies: ConceptStatusDependencies = {}): Promise<ConceptStatus> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const now = dependencies.now ?? new Date();

  const concept = await getConcept(conceptId, { supabase });
  if (!concept) throw new Error("Unknown concept.");

  const [mastery, retention, activeMisconceptions, transfer] = await Promise.all([
    getMasteryState(studentId, conceptId, { supabase }),
    getRetentionState(studentId, conceptId, { supabase }),
    listMisconceptions(studentId, { conceptId, status: "active" }, { supabase }),
    getTransferSignal(studentId, conceptId, { supabase }),
  ]);

  const retrievability = retention?.stability !== null && retention?.stability !== undefined && retention.lastReviewedAt ? calculateRetrievability(daysBetween(new Date(retention.lastReviewedAt), now), retention.stability) : null;
  const retentionUrgencyLevel = retrievability !== null ? getRetentionUrgency(retrievability).level : null;
  const evidenceCount = mastery?.evidenceCount ?? 0;

  const stage = deriveMasteryStage({ evidenceCount, pMastery: mastery?.pMastery ?? null, cardState: retention?.cardState ?? null, retrievability });

  // §30.4: transfer never shows for zero attempts ("no transfer line at all, never a misleading N/A").
  const transferVisible = transfer.counters.transferAttempts > 0 || transfer.counters.applicationAttempts > 0 || transfer.counters.recallAttempts > 0;
  const misconception = activeMisconceptions[0] ? { tag: activeMisconceptions[0].tag, description: activeMisconceptions[0].description, evidenceCount: activeMisconceptions[0].evidenceCount } : null;

  const why = explainConceptStatus({
    stage,
    evidenceCount,
    activeMisconception: misconception,
    retentionUrgencyLevel,
    transferReadiness: transferVisible ? transfer.readiness : null,
  });

  return {
    conceptId: concept.id,
    conceptKey: concept.conceptKey,
    displayName: concept.displayName,
    subject: concept.subject,
    stage,
    why,
    evidenceCount,
    reviewStatus: retention?.nextReviewAt !== undefined && retention?.nextReviewAt !== null ? getReviewStatus(new Date(retention.nextReviewAt), now) : null,
    retentionUrgencyLevel,
    transferReadiness: transferVisible ? transfer.readiness : null,
    activeMisconception: misconception,
  };
}
