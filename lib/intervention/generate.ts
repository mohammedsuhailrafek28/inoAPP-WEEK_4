// Recovery-plan orchestration (standout feature, Phase 4). Composes lib/intervention/detect.ts's
// verdict into a small, concept-focused recovery sequence -- never a second study planner.
//
// Deliberately does NOT run the recovery sequence through lib/plan/budget.ts::packPlan(): that
// function dedupes candidates by conceptId, keeping only the first occurrence -- exactly wrong for a
// PREREQUISITE_GAP recovery, whose whole point is to both LEARN and then PRACTICE the SAME blocker
// concept before rechecking the target (two deliberately distinct steps on one concept, not a
// ranked pool to select from). Every item's activityType/estimatedMinutes still comes from the exact
// same duration policy packPlan() itself uses (lib/plan/budget.ts::deriveActivityType(),
// lib/plan/constants.ts::PLAN_ACTIVITY_DURATION_MINUTES) -- only the packing/selection algorithm is
// skipped, not the policy.

import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getConceptByKey } from "@/lib/learning/concepts";
import { selectNextActivity } from "@/lib/pedagogy/select";
import { recordAgentActivity, type AgentActivityKind } from "@/lib/learning/agent-activity";
import { detectIntervention } from "@/lib/intervention/detect";
import { deriveActivityType } from "@/lib/plan/budget";
import { PLAN_ACTIVITY_DURATION_MINUTES } from "@/lib/plan/constants";
import { INTERVENTION_RECOVERY_BUDGET_MINUTES } from "@/lib/intervention/constants";
import type { LearningIntervention } from "@/types/intervention";
import type { PlanItem } from "@/types/plan";
import type { RevisionReasonCode } from "@/types/progress";

export class InterventionValidationError extends Error {}

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

export interface GenerateInterventionDependencies {
  supabase?: SupabaseClient;
  now?: Date;
  // Defaults to "PLAN_GENERATED" -- "Recheck Progress" passes "PLAN_REPLANNED" instead, mirroring
  // lib/plan/generate.ts's and lib/goal-plan/generate.ts's own activityKind convention exactly.
  activityKind?: Extract<AgentActivityKind, "PLAN_GENERATED" | "PLAN_REPLANNED">;
}

function toItem(order: number, conceptId: string, conceptKey: string, displayName: string, subject: string, reasonCodes: RevisionReasonCode[]): PlanItem {
  const activityType = deriveActivityType(reasonCodes);
  return { order, conceptId, conceptKey, displayName, subject, activityType, estimatedMinutes: PLAN_ACTIVITY_DURATION_MINUTES[activityType], reasonCodes };
}

const BLOCKER_REASON_PHRASE: Record<string, string> = {
  PREREQUISITE_NO_EVIDENCE: "not yet studied",
  PREREQUISITE_EVIDENCE_INSUFFICIENT: "not practiced enough yet",
  PREREQUISITE_NOT_MASTERED: "still developing",
};

export async function generateIntervention(studentId: string, conceptKey: string, dependencies: GenerateInterventionDependencies = {}): Promise<LearningIntervention> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const now = dependencies.now ?? new Date();

  const target = await getConceptByKey(conceptKey, { supabase });
  if (!target) throw new InterventionValidationError("Unknown concept.");

  const [detection, nextBestAction] = await Promise.all([
    detectIntervention(studentId, target.id, { supabase, now }),
    selectNextActivity(studentId, target.subject, { supabase, now }),
  ]);

  const status = detection.trigger === null ? "NOT_NEEDED" : "ACTIVE";

  let recoveryItems: PlanItem[] = [];
  let why = "";
  let materialFocusConceptKey = target.conceptKey;
  let materialFocusDisplayName = target.displayName;

  if (detection.trigger === "PREREQUISITE_GAP" && detection.blocker) {
    const blocker = detection.blocker;
    materialFocusConceptKey = blocker.conceptKey;
    materialFocusDisplayName = blocker.displayName;
    recoveryItems = [
      toItem(1, blocker.conceptId, blocker.conceptKey, blocker.displayName, target.subject, ["PREREQUISITE_BLOCKER"]),
      toItem(2, blocker.conceptId, blocker.conceptKey, blocker.displayName, target.subject, []),
      toItem(3, target.id, target.conceptKey, target.displayName, target.subject, []),
    ];
    why = `${target.displayName} depends on ${blocker.displayName}. ${blocker.displayName} is ${BLOCKER_REASON_PHRASE[blocker.reasonCode] ?? "not yet ready"}, so prerequisite remediation is recommended before continuing with ${target.displayName}.`;
  } else if (detection.trigger === "ACTIVE_MISCONCEPTION" && detection.misconception) {
    recoveryItems = [toItem(1, target.id, target.conceptKey, target.displayName, target.subject, ["ACTIVE_MISCONCEPTION"])];
    why = `A recurring pattern involving ${detection.misconception.description} is still active on ${target.displayName}. Reviewing this before practicing again is recommended.`;
  } else if (detection.trigger === "MASTERY_GAP") {
    recoveryItems = [toItem(1, target.id, target.conceptKey, target.displayName, target.subject, ["MASTERY_DEVELOPING"])];
    why = `${target.displayName}'s mastery is still developing based on current practice evidence. Additional focused practice is recommended.`;
  }

  const totalMinutes = recoveryItems.reduce((sum, item) => sum + item.estimatedMinutes, 0);
  if (totalMinutes > INTERVENTION_RECOVERY_BUDGET_MINUTES) {
    // Defense-in-depth only -- the hand-authored sequences above never actually reach this ceiling
    // (verified by tests/intervention-generate.test.ts), but a future change to the sequence itself
    // must not silently exceed the documented budget.
    throw new Error(`Recovery sequence (${totalMinutes} min) exceeds the intervention budget (${INTERVENTION_RECOVERY_BUDGET_MINUTES} min).`);
  }

  // Logged only when an intervention was actually generated (status === "ACTIVE") -- a "NOT_NEEDED"
  // result produced no recovery plan at all, so there is nothing to log, mirroring Phase C's
  // "never log a failed/no-op attempt as if it succeeded" rule. Reuses the existing PLAN_GENERATED/
  // PLAN_REPLANNED kinds with metadata.mode="intervention" rather than extending
  // agent_activity_log's CHECK constraint -- the same precedent Exam Goal Mode already established
  // for exactly this situation (see lib/goal-plan/generate.ts).
  if (status === "ACTIVE") {
    await recordAgentActivity(
      {
        studentId,
        subject: target.subject,
        kind: dependencies.activityKind ?? "PLAN_GENERATED",
        conceptId: target.id,
        conceptKey: target.conceptKey,
        reasonCodes: detection.reasonCodes,
        metadata: { mode: "intervention", trigger: detection.trigger, blockerConceptKey: detection.blocker?.conceptKey ?? null },
      },
      { supabase },
    );
  }

  return {
    subject: target.subject,
    targetConceptId: target.id,
    targetConceptKey: target.conceptKey,
    targetDisplayName: target.displayName,
    status,
    trigger: detection.trigger,
    reasonCodes: detection.reasonCodes,
    why,
    blocker: detection.blocker,
    misconception: detection.misconception,
    materialFocusConceptKey,
    materialFocusDisplayName,
    materialFocusSubject: target.subject,
    recoveryItems,
    nextBestAction,
    generatedAt: now.toISOString(),
  };
}
