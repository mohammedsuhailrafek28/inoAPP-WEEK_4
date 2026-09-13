// Learner-specific prerequisite readiness (ARCHITECTURE.md §6, Phase 6) -- structure (Phase 2)
// + learner BKT mastery (Phase 3) + evidence sufficiency + FSRS review-due status (Phase 5),
// combined server-side. This is NOT structural prerequisite info (that stays in
// lib/learning/concepts.ts, unchanged) -- it answers "is THIS student ready," not "what does the
// graph look like."
//
// BKT p_mastery is the sole authoritative prerequisite-knowledge signal (Step 4): IRT theta is
// never substituted for it (ability is a subject-level trait, not per-concept knowledge), and FSRS
// retrievability never erases mastery -- a due review is additive information (`ready_but_review_due`),
// never a downgrade to "unmastered" (Step 5). Read-only: this module writes nothing anywhere.

import "server-only";
import { LEARNING_CONFIG } from "@/lib/learning/constants";
import { getConcept, getPrerequisiteClosure, getPrerequisiteLearningOrder, getStructuralPrerequisiteInfo } from "@/lib/learning/concepts";
import { getMasteryState, hasSufficientEvidence } from "@/lib/learning/mastery";
import { getRetentionState } from "@/lib/learning/reviews";
import { getReviewStatus } from "@/lib/learning/retention";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { ConceptGraphNode, PrerequisiteReadinessDetail, PrerequisiteReadinessResult } from "@/types/learning";

const MASTERY_READY_THRESHOLD = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.MASTERY_READY_THRESHOLD.value;

export interface ReadinessDependencies {
  supabase?: ReturnType<typeof getSupabaseAdmin>;
}

/**
 * Classifies one prerequisite's readiness (Step 4): evidence sufficiency is checked BEFORE mastery
 * -- a prerequisite is never "ready" off insufficient evidence, even if p_mastery happens to read
 * above MASTERY_READY_THRESHOLD from one lucky answer. Retention only ever ADDS the
 * "ready_but_review_due" nuance on top of an already-"ready" verdict; it never demotes to
 * "not_mastered" (Step 5).
 */
async function classifyPrerequisite(studentId: string, concept: ConceptGraphNode, dependencies: ReadinessDependencies): Promise<PrerequisiteReadinessDetail> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const [masteryState, retentionState] = await Promise.all([
    getMasteryState(studentId, concept.id, { supabase }),
    getRetentionState(studentId, concept.id, { supabase }),
  ]);

  const reviewStatus = retentionState?.nextReviewAt ? getReviewStatus(new Date(retentionState.nextReviewAt), new Date()) : null;

  if (!masteryState) {
    return { conceptId: concept.id, conceptKey: concept.conceptKey, displayName: concept.displayName, pMastery: null, evidenceCount: 0, evidenceSufficient: false, status: "no_evidence", reviewStatus, blockerReasonCode: "PREREQUISITE_NO_EVIDENCE" };
  }

  const evidenceSufficient = hasSufficientEvidence(masteryState);
  if (!evidenceSufficient) {
    return {
      conceptId: concept.id,
      conceptKey: concept.conceptKey,
      displayName: concept.displayName,
      pMastery: masteryState.pMastery,
      evidenceCount: masteryState.evidenceCount,
      evidenceSufficient: false,
      status: "insufficient_evidence",
      reviewStatus,
      blockerReasonCode: "PREREQUISITE_EVIDENCE_INSUFFICIENT",
    };
  }

  if (masteryState.pMastery < MASTERY_READY_THRESHOLD) {
    return {
      conceptId: concept.id,
      conceptKey: concept.conceptKey,
      displayName: concept.displayName,
      pMastery: masteryState.pMastery,
      evidenceCount: masteryState.evidenceCount,
      evidenceSufficient: true,
      status: "not_mastered",
      reviewStatus,
      blockerReasonCode: "PREREQUISITE_NOT_MASTERED",
    };
  }

  const reviewDue = reviewStatus === "due" || reviewStatus === "overdue";
  return {
    conceptId: concept.id,
    conceptKey: concept.conceptKey,
    displayName: concept.displayName,
    pMastery: masteryState.pMastery,
    evidenceCount: masteryState.evidenceCount,
    evidenceSufficient: true,
    status: reviewDue ? "ready_but_review_due" : "ready",
    reviewStatus,
    blockerReasonCode: null, // ready either way -- review-due is additive info, never a blocker (Step 5)
  };
}

/**
 * The Step 6 contract: only DIRECT prerequisites are evaluated per call (§6: "transitive gating
 * falls out naturally" -- an ancestor can't itself be ready until its own prerequisites clear).
 * No Gemini anywhere in this function.
 */
export async function getPrerequisiteReadiness(studentId: string, targetConceptId: string, dependencies: ReadinessDependencies = {}): Promise<PrerequisiteReadinessResult> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const target = await getConcept(targetConceptId, { supabase });
  if (!target) throw new Error("Unknown concept.");

  const structural = await getStructuralPrerequisiteInfo(targetConceptId, { supabase });
  const directPrerequisites = await Promise.all(structural.directPrerequisites.map((concept) => classifyPrerequisite(studentId, concept, { supabase })));

  const isReady = (status: PrerequisiteReadinessDetail["status"]) => status === "ready" || status === "ready_but_review_due";
  const blockerIds = new Set(directPrerequisites.filter((detail) => !isReady(detail.status)).map((detail) => detail.conceptId));

  // Deterministic blocker order (Step 7): Phase 2's topological learning order, restricted to
  // blockers -- a subsequence of a topological order is itself a valid topological order.
  const fullOrder = await getPrerequisiteLearningOrder(targetConceptId, { supabase });
  const blockers = fullOrder.order.filter((node) => blockerIds.has(node.id)).map((node) => directPrerequisites.find((detail) => detail.conceptId === node.id)!);
  // Blockers structurally unreachable from the topo order (shouldn't happen -- direct prerequisites
  // are always ancestors of the target) are appended defensively so no blocker is silently dropped.
  for (const detail of directPrerequisites) {
    if (blockerIds.has(detail.conceptId) && !blockers.includes(detail)) blockers.push(detail);
  }

  // Remediation order (Step 7): every concept a student would need to work through to clear every
  // current blocker, in Phase 2's deterministic order -- each blocker's own prerequisite closure,
  // unioned, restricted from the target's full topo order (preserves topological validity).
  const closures = await Promise.all([...blockerIds].map((id) => getPrerequisiteClosure(id, { supabase })));
  const remediationSet = new Set<string>(blockerIds);
  for (const closure of closures) for (const concept of closure) remediationSet.add(concept.id);
  const remediationOrder: ConceptGraphNode[] = fullOrder.order.filter((node) => remediationSet.has(node.id));

  return {
    targetConceptId,
    targetConceptKey: target.conceptKey,
    directPrerequisites,
    ready: directPrerequisites.every((detail) => isReady(detail.status)),
    blockers,
    remediationOrder,
  };
}
