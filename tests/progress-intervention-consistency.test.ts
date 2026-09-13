// Regression coverage for the Week 4 hardening pass's #1 fix: a real product inconsistency found by
// manual testing, where Progress showed "Needs attention" / "Start Recovery" for a concept, but
// opening Intervention for that exact concept said "no longer needs special attention."
//
// Root cause: lib/learning/recommendations.ts's prerequisite-substitution step (Step 21) inserts a
// row keyed by the BLOCKER concept's own identity (e.g. "Rolling Hash") whenever it blocks some
// other ranked concept (e.g. "Rabin-Karp") -- correctly, per Step 21's own contract, even with zero
// evidence of the blocker's own. But lib/intervention/detect.ts's PREREQUISITE_GAP trigger answers a
// different, concept-relative question: "are THIS concept's own direct prerequisites ready" -- true
// for "Rolling Hash" itself whenever it has no unready prerequisite of its OWN (nearly always, for a
// leaf blocker), regardless of why it was surfaced in Progress. Feeding the blocker's own conceptKey
// into generateIntervention() therefore asks the wrong question and reliably comes back NOT_NEEDED.
//
// Fix: RevisionRecommendation now carries `interventionConceptKey` -- the ORIGINAL blocked target's
// key for a substituted blocker row, self for every ordinary row -- and components/ProgressPanel.tsx
// uses that (not the row's own `conceptKey`) for its "Start Recovery" action.

import assert from "node:assert/strict";
import test from "node:test";
import { getRevisionRecommendations } from "@/lib/learning/recommendations";
import { generateIntervention } from "@/lib/intervention/generate";
import { detectIntervention } from "@/lib/intervention/detect";
import { createFakeLearningSupabase } from "./support/fake-learning-db";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { createOrResolveConcept, addPrerequisite } from "@/lib/learning/concepts";
import { recordScoredOutcomeWithRetention } from "@/lib/learning/reviews";

async function setup() {
  const fake = createFakeLearningSupabase();
  const supabase = fake as never;
  const profile = await getOrCreateDefaultProfile({ supabase });
  return { supabase, fake, studentId: profile.id };
}

// Exact manual-test scenario (WEEK4 hardening report): Hashing mastered, Rolling Hash untouched,
// Rabin-Karp developing, Rolling Hash a direct prerequisite of Rabin-Karp.
async function buildRollingHashScenario(supabase: unknown, studentId: string) {
  const { concept: hashing } = await createOrResolveConcept({ subject: "algorithms", displayName: "Hashing" }, { supabase: supabase as never });
  const { concept: rollingHash } = await createOrResolveConcept({ subject: "algorithms", displayName: "Rolling Hash" }, { supabase: supabase as never });
  const { concept: rabinKarp } = await createOrResolveConcept({ subject: "algorithms", displayName: "Rabin-Karp" }, { supabase: supabase as never });
  await addPrerequisite(rollingHash.id, hashing.id, { supabase: supabase as never });
  await addPrerequisite(rabinKarp.id, rollingHash.id, { supabase: supabase as never });
  for (let i = 0; i < 5; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId: hashing.id, outcome: "correct", difficulty: "medium" }, { supabase: supabase as never });
  // rolling-hash: deliberately untouched -- zero evidence, the point of the prerequisite gap.
  for (let i = 0; i < 3; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId: rabinKarp.id, outcome: "incorrect", difficulty: "medium" }, { supabase: supabase as never });
  return { hashing, rollingHash, rabinKarp };
}

test("exact Rolling Hash mismatch scenario: Progress's own recovery key produces a valid ACTIVE intervention", async () => {
  const { supabase, studentId } = await setup();
  const { rollingHash, rabinKarp } = await buildRollingHashScenario(supabase, studentId);

  const { recommendations } = await getRevisionRecommendations(studentId, { subject: "algorithms" }, { supabase: supabase as never });
  const row = recommendations.find((r) => r.conceptKey === rollingHash.conceptKey);
  assert.ok(row, "Rolling Hash must still be surfaced as a prerequisite blocker (Step 21)");
  assert.ok(row!.reasonCodes.includes("PREREQUISITE_BLOCKER"), "the row must carry the reason Progress uses to show \"Needs attention\" / \"Start Recovery\"");

  // The bug: Progress used to pass the row's OWN conceptKey (the blocker's) to Start Recovery.
  assert.equal(row!.interventionConceptKey, rabinKarp.conceptKey, "recovery must target the ORIGINAL blocked concept, not the blocker itself");
  assert.notEqual(row!.interventionConceptKey, row!.conceptKey, "for a substituted blocker row, the recovery target is a different concept than the row's own identity");

  const intervention = await generateIntervention(studentId, row!.interventionConceptKey, { supabase: supabase as never });
  assert.equal(intervention.status, "ACTIVE", "Progress must never show Start Recovery for a row that produces no real intervention");
  assert.equal(intervention.trigger, "PREREQUISITE_GAP");
  assert.equal(intervention.blocker?.conceptKey, rollingHash.conceptKey);
});

test("demonstrates the pre-fix bug directly: invoking intervention on the blocker's OWN key (the old behavior) is NOT_NEEDED", async () => {
  const { supabase, studentId } = await setup();
  const { rollingHash } = await buildRollingHashScenario(supabase, studentId);

  // This is exactly what components/ProgressPanel.tsx used to pass to onStartRecovery(): the
  // blocker row's own conceptKey. Rolling Hash has no unready prerequisite of ITS OWN (Hashing is
  // mastered), no active misconception, and zero evidence (stage NEW, not LEARNING/DEVELOPING) --
  // so detectIntervention() correctly (per its own documented policy) finds nothing to recover from.
  const stale = await generateIntervention(studentId, rollingHash.conceptKey, { supabase: supabase as never });
  assert.equal(stale.status, "NOT_NEEDED", "reproduces the exact reported inconsistency: recovery on the blocker's own key finds nothing");

  const direct = await detectIntervention(studentId, rollingHash.id, { supabase: supabase as never });
  assert.equal(direct.trigger, null);
});

test("Progress START RECOVERY implies Intervention ACTIVE, generalized across both real intervention triggers", async () => {
  const { supabase, studentId } = await setup();

  // Trigger 1: prerequisite blocker (row identity != recovery target).
  const { rabinKarp } = await buildRollingHashScenario(supabase, studentId);

  // Trigger 2: an active misconception on an ordinary (non-blocker) ranked concept (row identity ==
  // recovery target -- detectIntervention's ACTIVE_MISCONCEPTION trigger is self-referential).
  const { concept: misconceptual } = await createOrResolveConcept({ subject: "algorithms", displayName: "Misconceptual Concept" }, { supabase: supabase as never });
  await recordScoredOutcomeWithRetention({ studentId, conceptId: misconceptual.id, outcome: "incorrect", difficulty: "medium" }, { supabase: supabase as never });
  const { recordLearningEvent } = await import("@/lib/learning/events");
  const { recordMisconceptionEvidence } = await import("@/lib/learning/misconceptions");
  for (let i = 0; i < 2; i++) {
    const quizEvent = await recordLearningEvent({ studentId, conceptId: misconceptual.id, eventType: "QUIZ_ANSWERED", metadata: { correct: false } }, { supabase: supabase as never });
    const observed = await recordLearningEvent({ studentId, conceptId: misconceptual.id, eventType: "MISCONCEPTION_OBSERVED", metadata: { proposedByLlm: true, relatedEventId: quizEvent.id, tag: "t" } }, { supabase: supabase as never });
    await recordMisconceptionEvidence({ studentId, conceptId: misconceptual.id, sourceEventId: observed.id, tag: "t", description: "d" }, { supabase: supabase as never });
  }

  const { recommendations } = await getRevisionRecommendations(studentId, { subject: "algorithms" }, { supabase: supabase as never });

  // hasInterventionTrigger() in components/ProgressPanel.tsx, reproduced here: exactly these two
  // reason codes ever show the "Needs attention" badge and the "Start Recovery" button.
  const needsAttentionRows = recommendations.filter((r) => r.reasonCodes.includes("PREREQUISITE_BLOCKER") || r.reasonCodes.includes("ACTIVE_MISCONCEPTION"));
  assert.ok(needsAttentionRows.length >= 2, "both the prerequisite-blocker and active-misconception rows must be present");

  for (const row of needsAttentionRows) {
    const intervention = await generateIntervention(studentId, row.interventionConceptKey, { supabase: supabase as never });
    assert.equal(intervention.status, "ACTIVE", `row ${row.displayName} shows Start Recovery but produced no intervention`);
  }

  // Sanity: the misconception row's recovery target is itself; the blocker row's is Rabin-Karp.
  const misconceptionRow = needsAttentionRows.find((r) => r.conceptKey === misconceptual.conceptKey)!;
  assert.equal(misconceptionRow.interventionConceptKey, misconceptual.conceptKey);
  const blockerRow = needsAttentionRows.find((r) => r.reasonCodes.includes("PREREQUISITE_BLOCKER"))!;
  assert.equal(blockerRow.interventionConceptKey, rabinKarp.conceptKey);
});

test("no fake intervention for a truly healthy, brand-new concept: never surfaced, and never ACTIVE if queried directly", async () => {
  const { supabase, studentId } = await setup();
  const { concept } = await createOrResolveConcept({ subject: "Fresh Subject", displayName: "Untouched Concept" }, { supabase: supabase as never });

  const { recommendations } = await getRevisionRecommendations(studentId, { subject: "Fresh Subject" }, { supabase: supabase as never });
  assert.equal(recommendations.length, 0, "a concept with zero evidence that blocks nothing must never be shown as needing attention");

  const intervention = await generateIntervention(studentId, concept.conceptKey, { supabase: supabase as never });
  assert.equal(intervention.status, "NOT_NEEDED");
  assert.equal(intervention.trigger, null);
});
