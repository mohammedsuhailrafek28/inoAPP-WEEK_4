// Bounded learner-context builder (ARCHITECTURE.md §22, Phase 10). Module path matches the
// architecture's own exact module list (§29: "context-builder.ts bounded LEARNER CONTEXT +
// degradation cascade (§22)").
//
// Pure `buildBoundedLearnerContext()` -- takes already-resolved signals, produces a budget-
// respecting text block with a graduated degradation cascade. No I/O, no Gemini call, no database
// access; the DB-backed gathering of those signals belongs to the caller
// (lib/personalization/prompt-context.ts), matching the pure/impure split used everywhere else in
// this codebase.
//
// §22's own explicit "never included" list is enforced structurally, not just by convention: this
// file's input type has no field for raw `learning_events`, the full `learner_concept_state` row,
// embeddings, pending narrative memories, or raw calibration records -- there is nothing to
// accidentally render because there is nowhere to put it.

import { LEARNING_CONFIG } from "@/lib/learning/constants";
import type { MasteryStage } from "@/lib/learning/olm";
import type { ExplanationStyle, PedagogicalAction, PreferredPace, ScaffoldingLevel } from "@/types/learning";

const BUDGET = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.LEARNER_CONTEXT_BUDGET.value;

// §23's minimal weakness-ranking formula used to have its own copy inline here (Phase 10, before
// `lib/learning/recommendations.ts` existed). Phase 11 built that module as the ONE canonical §23
// implementation (§29's own locked module list); this file now consumes
// `rankRevisionCandidates()`/`RevisionCandidateSignal` from there instead of duplicating the
// formula a second time -- see lib/personalization/prompt-context.ts, the sole caller that gathers
// "top 2 weak concepts" for this file's `weakConcepts` field.

// --- The bounded context itself -------------------------------------------------------------------

export interface LearnerContextProfile {
  academicLevel: string;
  preferredExplanationStyle: ExplanationStyle;
  preferredPace: PreferredPace;
}

export interface WeakConceptContext {
  conceptKey: string;
  displayName: string;
  stage: MasteryStage;
}

export interface ActiveMisconceptionContext {
  tag: string;
  description: string;
}

export interface CurrentConceptContext {
  displayName: string;
  stage: MasteryStage; // qualitative only -- raw p_mastery/retrievability floats are never rendered into the prompt text (§30's "raw internals never exposed" philosophy, applied here too)
}

// Every field the caller may supply. §22 lists action/scaffolding-tier as part of this same
// "always included" bounded block; this file still accepts them (renderFixed() below folds them
// in) so a caller using ONLY this module gets a complete, spec-faithful block. The RAG integration
// (lib/documents/rag-prompt.ts) additionally renders them as their own small, always-present
// `<teaching_strategy>` tag ahead of `<learner_context>` (Step 31's structural convention) and
// passes `pedagogicalAction: null`/`scaffoldingLevel: null` here to avoid rendering them twice --
// both readings of §22 are satisfied, never in conflict, just two presentations of the same three
// "always included, fixed" fields.
export interface LearnerContextInput {
  profile: LearnerContextProfile;
  pedagogicalAction: PedagogicalAction | null;
  scaffoldingLevel: ScaffoldingLevel | null;
  weakConcepts: WeakConceptContext[]; // already ranked + limited to top 2 by the caller (rankWeakConcepts())
  activeMisconception: ActiveMisconceptionContext | null;
  narrativeMemory: string | null; // one CONFIRMED observation's content, already selected by the caller
  currentConcept: CurrentConceptContext | null;
}

export interface BoundedLearnerContext {
  text: string; // "" when there is nothing at all to say (e.g. a brand-new learner, no concept)
  includedSections: string[];
  droppedSections: string[]; // sections that existed in the input but didn't fit the budget
  length: number;
}

// §22: "Always included (small, fixed)" -- this block is exempt from the degradation cascade
// below by design, never itself trimmed or dropped. It is expected to always be small in
// practice (three short labels), so this is not a real budget-overrun risk at the locked 1,500-
// character budget; the cascade's job is only to fit the four CONDITIONAL sections around it.
function renderFixed(input: LearnerContextInput): string {
  const lines = [`Learner profile: academic level ${input.profile.academicLevel}, preferred style ${input.profile.preferredExplanationStyle}, preferred pace ${input.profile.preferredPace}.`];
  if (input.pedagogicalAction) lines.push(`This turn's teaching action: ${input.pedagogicalAction}.`);
  if (input.scaffoldingLevel) lines.push(`Support level: ${input.scaffoldingLevel}.`);
  return lines.join(" ");
}

function renderWeakConcepts(weakConcepts: WeakConceptContext[]): string | null {
  if (weakConcepts.length === 0) return null;
  return `Other concepts this learner is still developing: ${weakConcepts.map((c) => `${c.displayName} (${c.stage})`).join(", ")}.`;
}

function renderMisconception(misconception: ActiveMisconceptionContext | null): string | null {
  if (!misconception) return null;
  return `Confirmed recurring error on this concept: ${misconception.description}.`;
}

function renderNarrative(narrative: string | null): string | null {
  if (!narrative) return null;
  return `Prior observation: ${narrative}`;
}

function renderCurrentConcept(currentConcept: CurrentConceptContext | null): string | null {
  if (!currentConcept) return null;
  return `Current concept status: ${currentConcept.displayName} - ${currentConcept.stage}.`;
}

/**
 * §22's graduated degradation cascade, pure and deterministic. Builds the full text with every
 * available section, then drops sections in the LOCKED order (weak concepts -> misconception ->
 * narrative -> current concept) until the result fits `budget` characters -- "dropped last, only
 * if literally nothing else fits" for the current-concept section, exactly as specified.
 */
export function buildBoundedLearnerContext(input: LearnerContextInput, budget = BUDGET): BoundedLearnerContext {
  const fixed = renderFixed(input);

  type Section = { name: string; text: string | null };
  // Order matches §22's own numbering (1 dropped first ... 4 dropped last) exactly.
  const optional: Section[] = [
    { name: "weakConcepts", text: renderWeakConcepts(input.weakConcepts) },
    { name: "activeMisconception", text: renderMisconception(input.activeMisconception) },
    { name: "narrativeMemory", text: renderNarrative(input.narrativeMemory) },
    { name: "currentConcept", text: renderCurrentConcept(input.currentConcept) },
  ];

  const present = optional.filter((s): s is { name: string; text: string } => s.text !== null);

  let included = [...present];
  const droppedForBudget: string[] = [];

  function render(sections: { name: string; text: string }[]): string {
    return [fixed, ...sections.map((s) => s.text)].filter(Boolean).join(" ");
  }

  while (render(included).length > budget && included.length > 0) {
    const removed = included[0]; // section 1 (weakConcepts) is first in the array -> dropped first; currentConcept is last -> dropped last
    droppedForBudget.push(removed.name);
    included = included.slice(1);
  }

  const text = render(included);
  return { text, includedSections: included.map((s) => s.name), droppedSections: droppedForBudget, length: text.length };
}

export { BUDGET as LEARNER_CONTEXT_BUDGET };
