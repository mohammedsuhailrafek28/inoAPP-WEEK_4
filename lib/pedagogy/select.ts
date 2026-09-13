// §17's composed subject-scoped entry point (ARCHITECTURE.md, Phase 9):
// `selectNextActivity(studentId, subject, now) -> {phase, conceptSelection, decision, ...}`.
// Module path/name matches the architecture's own signature exactly (§17 header: "a deterministic
// function, lib/pedagogy/select.ts::selectNextActivity(state, now) -> {concept, action, difficulty,
// rationale}").
//
// Composes the three §17 pieces, never duplicating any of their logic:
//   §17.1 lib/pedagogy/phase.ts::resolvePhase()
//   §17.2 lib/pedagogy/select-concept.ts::selectConcept()
//   §17.3 lib/pedagogy/select-action.ts::selectAction() (Phase 8, unchanged)
//
// This is ARCHITECTURE.md §28's `/api/learning/next-activity` (GET {subject} -> {concept,
// action, difficulty, rationale}) and the function `/api/quiz/generate` internally calls instead of
// trusting a client-supplied concept (§28's own note on that route).
//
// One deliberate side effect, unlike Phase 8's read-only getNextLearningAction(): §17.2's anti-
// repeat rule needs to know what was selected last time, so this function persists
// learner_ability.last_selected_concept_id after choosing a concept. This is the one place in the
// pedagogical engine that writes anything -- justified because "select the next activity" and
// "show it to the student" are the same event here (there is no separate confirmation step), and
// without persisting it the anti-repeat rule could never see its own prior effect on the next call.

import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { resolvePhase } from "@/lib/pedagogy/phase";
import { buildConceptCandidates, selectConcept } from "@/lib/pedagogy/select-concept";
import { buildPedagogicalContext, selectAction, PedagogyValidationError } from "@/lib/pedagogy/select-action";
import { getAbility, setLastSelectedConcept } from "@/lib/learning/ability";
import { normalizeSubjectKey } from "@/lib/learning/concepts";
import { getLearnerMemoryContext } from "@/lib/learning/memory";
import type { NextActivityResult } from "@/types/learning";

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

export interface SelectNextActivityDependencies {
  supabase?: SupabaseClient;
  now?: Date;
}

export async function selectNextActivity(studentId: string, subject: string, dependencies: SelectNextActivityDependencies = {}): Promise<NextActivityResult> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const now = dependencies.now ?? new Date();
  const normalizedSubject = normalizeSubjectKey(subject);

  // These three reads are mutually independent (none consumes another's output, and none writes
  // anything -- resolvePhase/buildConceptCandidates/getAbility are all pure reads), so running them
  // concurrently is a pure I/O latency win with no semantic change, matching the same pattern
  // lib/learning/analytics.ts already uses for its independent per-subject/per-concept reads.
  const [phase, candidates, ability] = await Promise.all([
    resolvePhase(studentId, normalizedSubject, { supabase, now }),
    buildConceptCandidates(studentId, normalizedSubject, { supabase }),
    getAbility(studentId, normalizedSubject, { supabase }),
  ]);

  const selection = selectConcept(phase, candidates, ability?.lastSelectedConceptId ?? null, now);
  if (!selection.conceptId) {
    return { phase, conceptSelection: selection.reasonCode, decision: null, nonAuthoritativeContext: { recentEpisodes: [], relevantNarratives: [] } };
  }

  const input = await buildPedagogicalContext(studentId, selection.conceptId, { supabase });
  const decision = selectAction(input, now);

  // Independent of each other: persisting the anti-repeat marker and reading memory context touch
  // different tables and neither depends on the other's result.
  const [, memoryContext] = await Promise.all([
    setLastSelectedConcept(studentId, normalizedSubject, selection.conceptId, now, { supabase }),
    getLearnerMemoryContext({ studentId, conceptId: selection.conceptId }, { supabase }),
  ]);
  return {
    phase,
    conceptSelection: selection.reasonCode,
    decision,
    nonAuthoritativeContext: { recentEpisodes: memoryContext.recentEpisodes, relevantNarratives: memoryContext.relevantNarratives },
  };
}

export { PedagogyValidationError };
