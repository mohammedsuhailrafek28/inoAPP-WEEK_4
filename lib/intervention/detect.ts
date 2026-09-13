// Intervention detection (standout feature, Phase 2). Answers exactly one question: "does this
// concept currently need targeted intervention, and why?" -- composed entirely from existing,
// already-authoritative reads. No new mastery model, no new prerequisite engine, no weighted
// intervention score.
//
// Precedence mirrors lib/pedagogy/select-action.ts's own §17.3 cascade EXACTLY, for the subset of
// rows that represent a genuine learner problem (not merely a teaching-style choice):
//   row 2  PREREQUISITE_BLOCKED        -> here: PREREQUISITE_GAP
//   row 3  ACTIVE_MISCONCEPTION        -> here: ACTIVE_MISCONCEPTION
//   row 4-ish (DEVELOPING/LEARNING stage) -> here: MASTERY_GAP
// Two of the cascade's other rows are deliberately NOT reused as intervention triggers:
//   - RETENTION_CRITICAL_ON_MASTERED (row 1) / REVIEW_DUE stage: routine maintenance, already served
//     by SPACED_REVIEW and the Plan's own "review" activity type -- not a "problem" to recover from.
//   - INSUFFICIENT_EVIDENCE (row 4): means "not yet attempted," not "struggling" -- there is no
//     established gap yet to construct a recovery sequence around.
// This file reuses the three underlying reads directly (getPrerequisiteReadiness/listMisconceptions/
// getConceptStatus) rather than calling the full 9-action pedagogical cascade, because that cascade
// also encodes teaching-style rows (SIMPLIFY/QUIZ/TRANSFER_CHALLENGE/DEEPEN) that have no "is this a
// problem" meaning to reverse-map -- composing the narrower building blocks directly is the more
// literal, least-duplicative reuse for this narrower question.

import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getPrerequisiteReadiness } from "@/lib/learning/readiness";
import { listMisconceptions } from "@/lib/learning/misconceptions";
import { getConceptStatus } from "@/lib/learning/olm";
import type { InterventionBlocker, InterventionMisconceptionDetail, InterventionTrigger } from "@/types/intervention";
import type { RevisionReasonCode } from "@/types/progress";

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

export interface InterventionDetectionDependencies {
  supabase?: SupabaseClient;
  now?: Date;
}

export interface InterventionDetectionResult {
  trigger: InterventionTrigger | null;
  reasonCodes: RevisionReasonCode[];
  blocker: InterventionBlocker | null; // non-null only when trigger === "PREREQUISITE_GAP"
  misconception: InterventionMisconceptionDetail | null; // non-null only when trigger === "ACTIVE_MISCONCEPTION"
}

export async function detectIntervention(studentId: string, conceptId: string, dependencies: InterventionDetectionDependencies = {}): Promise<InterventionDetectionResult> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const now = dependencies.now ?? new Date();

  // Independent reads -- none consumes another's output.
  const [readiness, activeMisconceptions, status] = await Promise.all([
    getPrerequisiteReadiness(studentId, conceptId, { supabase }),
    listMisconceptions(studentId, { conceptId, status: "active" }, { supabase }),
    getConceptStatus(studentId, conceptId, { supabase, now }),
  ]);

  // Row 2 equivalent: an unready DIRECT prerequisite. readiness.blockers is already in Phase 2's
  // deterministic remediation order (lib/learning/readiness.ts's own contract) -- the first entry is
  // the correct "likely blocker" to lead with, never chosen by this function.
  if (!readiness.ready) {
    const blockerDetail = readiness.blockers[0];
    const blocker: InterventionBlocker | null = blockerDetail
      ? { conceptId: blockerDetail.conceptId, conceptKey: blockerDetail.conceptKey, displayName: blockerDetail.displayName, reasonCode: blockerDetail.blockerReasonCode! }
      : null;
    return { trigger: "PREREQUISITE_GAP", reasonCodes: ["PREREQUISITE_BLOCKER"], blocker, misconception: null };
  }

  // Row 3 equivalent: an active (never candidate/resolved) misconception on the target itself.
  if (activeMisconceptions.length > 0) {
    // Earliest-activated first -- mirrors lib/pedagogy/select-action.ts::pickMisconceptionTag()'s own tie-break.
    const chosen = [...activeMisconceptions].sort((a, b) => new Date(a.firstSeenAt).getTime() - new Date(b.firstSeenAt).getTime())[0];
    return { trigger: "ACTIVE_MISCONCEPTION", reasonCodes: ["ACTIVE_MISCONCEPTION"], blocker: null, misconception: { tag: chosen.tag, description: chosen.description } };
  }

  // Mastery-gap equivalent: the existing OLM stage already answers "is this concept's mastery still
  // developing" (lib/learning/olm.ts::deriveMasteryStage()) -- LEARNING and DEVELOPING both qualify;
  // REVIEW_DUE, PROFICIENT, MASTERED, and NEW (no evidence yet) do not.
  if (status.stage === "LEARNING" || status.stage === "DEVELOPING") {
    return { trigger: "MASTERY_GAP", reasonCodes: ["MASTERY_DEVELOPING"], blocker: null, misconception: null };
  }

  return { trigger: null, reasonCodes: [], blocker: null, misconception: null };
}
