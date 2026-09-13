// Learning plan generation (Week 4, Phase 2). A thin orchestration layer that composes ONLY
// existing Week 3 systems: lib/learning/recommendations.ts for priority + prerequisite order (never
// re-scored here), lib/pedagogy/select.ts for the single next-best-action (never recomputed here),
// and lib/plan/budget.ts's pure packer for time-budgeting. This file contains no mastery/retention/
// prerequisite/priority logic of its own -- see each import for the one existing module that owns
// that signal.
//
// Read-only with respect to learner state, mirroring lib/learning/recommendations.ts's own "not
// persisted" contract (ARCHITECTURE.md §23): nothing here writes a learning_events/mastery/
// retention row, and no plan (or plan item) is stored anywhere yet. It DOES write one append-only
// agent_activity_log row per successful call (Week 4, Phase C) -- that table is explicitly not
// learner evidence (see lib/learning/agent-activity.ts's own header comment), so this stays
// consistent with "never mutates learner state" while still satisfying the decision-logging
// requirement. A failed call (an invalid budget, an unknown subject) never reaches the logging line.

import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getRevisionRecommendations, type RevisionRecommendation } from "@/lib/learning/recommendations";
import { selectNextActivity } from "@/lib/pedagogy/select";
import { normalizeSubjectKey } from "@/lib/learning/concepts";
import { packPlan, PlanValidationError, type PlanCandidate } from "@/lib/plan/budget";
import { recordAgentActivity, type AgentActivityKind } from "@/lib/learning/agent-activity";
import type { LearningPlan } from "@/types/plan";
import type { RevisionReasonCode } from "@/types/progress";

export { PlanValidationError };

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

export interface GenerateLearningPlanDependencies {
  supabase?: SupabaseClient;
  now?: Date;
  // Defaults to "PLAN_GENERATED" -- lib/plan/replan.ts passes "PLAN_REPLANNED" instead so the two
  // call sites share this one implementation without either mislabeling the other's decision kind.
  activityKind?: Extract<AgentActivityKind, "PLAN_GENERATED" | "PLAN_REPLANNED">;
  // lib/plan/replan.ts's own "skip this one for now" affordance (Phase D). A request-scoped filter
  // only -- it never touches learner_concept_state or any other evidence table, so a skip here has
  // zero effect on priority/mastery/readiness for any OTHER call. This is the one honest way to
  // "replan around" an item without inventing a persisted skip/dismiss feature the task explicitly
  // didn't ask for.
  excludeConceptIds?: string[];
  // Purely informational (Phase D): recorded on the activity log row so "why did this replan
  // happen" is human-answerable, but never fed into packPlan() or any ranking -- completing an item
  // changes learner state only through the existing trusted quiz/review write paths, never through
  // this field.
  completedConceptId?: string | null;
}

function toCandidate(recommendation: RevisionRecommendation): PlanCandidate {
  return {
    conceptId: recommendation.conceptId,
    conceptKey: recommendation.conceptKey,
    displayName: recommendation.displayName,
    subject: recommendation.subject,
    reasonCodes: recommendation.reasonCodes as RevisionReasonCode[],
  };
}

/**
 * Composes existing recommendation ranking + next-activity intelligence into one time-budgeted plan
 * for `subject`. `availableMinutes` is validated by lib/plan/budget.ts's packPlan() -- this function
 * adds no separate validation of its own, so a caller (the API route) that wants a 400 before doing
 * any work should validate the same bounds up front too.
 */
export async function generateLearningPlan(studentId: string, subject: string, availableMinutes: number, dependencies: GenerateLearningPlanDependencies = {}): Promise<LearningPlan> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const now = dependencies.now ?? new Date();
  const normalizedSubject = normalizeSubjectKey(subject);

  // Independent reads: the ranked-candidate gather doesn't need selectNextActivity()'s result, and
  // vice versa -- a pure I/O latency win, the same pattern lib/pedagogy/select.ts itself already
  // uses for its own independent reads.
  const [{ recommendations, transferPractice }, nextBestAction] = await Promise.all([
    getRevisionRecommendations(studentId, { subject: normalizedSubject }, { supabase, now }),
    selectNextActivity(studentId, normalizedSubject, { supabase, now }),
  ]);

  // Priority-ranked (already prerequisite-order-enforced) candidates first, then the separate
  // transfer-practice category appended -- the same two-list contract components/ProgressPanel.tsx
  // already renders. packPlan()'s own dedupe collapses any concept that happens to appear in both
  // to its higher-priority (recommendations-list) occurrence.
  const excluded = new Set(dependencies.excludeConceptIds ?? []);
  const candidates: PlanCandidate[] = [...recommendations, ...transferPractice].filter((c) => !excluded.has(c.conceptId)).map(toCandidate);

  const { items, estimatedMinutes } = packPlan(candidates, availableMinutes);

  // The one row logged per successful call (Phase C): the top scheduled item's own identity/reason
  // codes when the plan isn't empty, otherwise the fallback next-best-action's -- either way, an
  // already-computed, already-deterministic reason, never a new one invented for the log entry.
  const primaryItem = items[0];
  const conceptId = primaryItem?.conceptId ?? nextBestAction.decision?.targetConceptId ?? null;
  const conceptKey = primaryItem?.conceptKey ?? nextBestAction.decision?.targetConceptKey ?? null;
  const reasonCodes = primaryItem?.reasonCodes ?? nextBestAction.decision?.reasonCodes ?? [];

  await recordAgentActivity(
    {
      studentId,
      subject: normalizedSubject,
      kind: dependencies.activityKind ?? "PLAN_GENERATED",
      conceptId,
      conceptKey,
      reasonCodes,
      metadata: {
        availableMinutes,
        estimatedMinutes,
        itemCount: items.length,
        ...(dependencies.excludeConceptIds?.length ? { skippedConceptIds: dependencies.excludeConceptIds } : {}),
        ...(dependencies.completedConceptId ? { completedConceptId: dependencies.completedConceptId } : {}),
      },
    },
    { supabase },
  );

  return {
    subject: normalizedSubject,
    availableMinutes,
    estimatedMinutes,
    generatedAt: now.toISOString(),
    items,
    nextBestAction,
  };
}
