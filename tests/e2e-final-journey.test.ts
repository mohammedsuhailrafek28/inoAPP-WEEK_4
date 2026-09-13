import assert from "node:assert/strict";
import test from "node:test";
import { createFakeLearningSupabase } from "./support/fake-learning-db";
import { getOrCreateDefaultProfile, updateProfile } from "@/lib/learning/profile";
import { createOrResolveConcept, addPrerequisite } from "@/lib/learning/concepts";
import { getConceptStatus } from "@/lib/learning/olm";
import { getRevisionRecommendations } from "@/lib/learning/recommendations";
import { recordScoredOutcomeWithRetention } from "@/lib/learning/reviews";
import { openCalibrationPrediction, resolveCalibrationPrediction, getCalibrationSignal } from "@/lib/learning/calibration";

// Phase 13 Step 44: a final deterministic journey chaining the pieces tests/olm-journey.test.ts
// (mastery -> review-due -> misconception -> transfer) does NOT already chain in one flow:
// profile configuration, a prerequisite-blocked concept with zero evidence of its own, and
// calibration crossing its 5-sample visibility threshold -- all against one profile, proving these
// subsystems compose correctly rather than merely working in isolation.
test("end-to-end journey: profile, prerequisite blocking, and calibration threshold compose correctly for one learner", async () => {
  const fake = createFakeLearningSupabase();
  const supabase = fake as never;

  // 1. New learner bootstraps with placeholder profile values.
  const bootstrap = await getOrCreateDefaultProfile({ supabase });
  assert.equal(bootstrap.displayName, "Student");

  // 2. Profile is configured with real learning preferences.
  const profile = await updateProfile(
    {
      displayName: "Journey Learner",
      academicLevel: "Undergraduate",
      subjects: ["Algorithms"],
      preferredExplanationStyle: "detailed",
      preferredDifficulty: "hard",
      preferredPace: "accelerated",
    },
    { supabase },
  );
  assert.equal(profile.id, bootstrap.id, "configuring the profile must not create a second learner identity");
  assert.equal(profile.preferredExplanationStyle, "detailed");

  // 3. Two concepts: `target` requires `foundation` as a prerequisite. `foundation` has zero
  // evidence; `target` already has real (weak) evidence, so it independently qualifies for the
  // ranked list -- the scenario Step 11's prerequisite carve-out actually applies to (a
  // zero-evidence concept is otherwise never ranked on its own, per tests/recommendations.test.ts).
  const { concept: foundation } = await createOrResolveConcept({ subject: "Algorithms", displayName: "Foundation Concept" }, { supabase });
  const { concept: target } = await createOrResolveConcept({ subject: "Algorithms", displayName: "Target Concept" }, { supabase });
  await addPrerequisite(target.id, foundation.id, { supabase });
  for (let i = 0; i < 3; i++) {
    await recordScoredOutcomeWithRetention({ studentId: profile.id, conceptId: target.id, outcome: "incorrect", difficulty: "medium" }, { supabase });
  }

  assert.equal((await getConceptStatus(profile.id, foundation.id, { supabase })).stage, "NEW");

  // 4. Revision recommendations surface the zero-evidence prerequisite BEFORE the concept it
  // blocks -- the one architecture-sanctioned exception to "a NEW concept never ranks" (Step 11).
  const revision = await getRevisionRecommendations(profile.id, { subject: "Algorithms" }, { supabase });
  const blockerEntry = revision.recommendations.find((r) => r.conceptKey === foundation.conceptKey);
  assert.ok(blockerEntry?.reasonCodes.includes("PREREQUISITE_BLOCKER"), "foundation must be recommended as the blocker for target");
  const blockerIndex = revision.recommendations.findIndex((r) => r.conceptKey === foundation.conceptKey);
  const targetIndex = revision.recommendations.findIndex((r) => r.conceptKey === target.conceptKey);
  assert.ok(blockerIndex !== -1 && (targetIndex === -1 || blockerIndex < targetIndex), "the blocker must rank ahead of the concept it blocks");

  // 5. Learner practices the foundation concept to mastery via the same quiz-scoring orchestrator
  // the real /api/quiz/[id]/submit route uses.
  let status = await getConceptStatus(profile.id, foundation.id, { supabase });
  for (let i = 0; i < 10 && status.stage !== "MASTERED"; i++) {
    await recordScoredOutcomeWithRetention({ studentId: profile.id, conceptId: foundation.id, outcome: "correct", difficulty: "medium" }, { supabase });
    status = await getConceptStatus(profile.id, foundation.id, { supabase });
  }
  assert.equal(status.stage, "MASTERED");

  // 6. With the prerequisite mastered, the revision engine no longer needs to surface it as a
  // blocker for target (structural readiness is satisfied).
  const revisionAfterMastery = await getRevisionRecommendations(profile.id, { subject: "Algorithms" }, { supabase });
  const staleBlockerEntry = revisionAfterMastery.recommendations.find((r) => r.conceptKey === target.conceptKey);
  assert.ok(!staleBlockerEntry?.reasonCodes.includes("PREREQUISITE_BLOCKER"), "target must not still be reported as prerequisite-blocked once the prerequisite is mastered");

  // 7. Calibration starts with no visible qualitative state below the 5-sample threshold (§13),
  // even though every prediction so far has been well-calibrated (small |bias|).
  for (let i = 0; i < 4; i++) {
    await openCalibrationPrediction({ studentId: profile.id, conceptId: target.id, rating: 5 }, { supabase }); // predicted = 1.0
    const { event } = await recordScoredOutcomeWithRetention({ studentId: profile.id, conceptId: target.id, outcome: "correct", difficulty: "medium" }, { supabase });
    await resolveCalibrationPrediction({ studentId: profile.id, conceptId: target.id, sourceEventId: event.id }, { supabase });
  }
  const belowThreshold = await getCalibrationSignal(profile.id, { supabase });
  assert.equal(belowThreshold.sampleCount, 4);
  assert.equal(belowThreshold.state, "insufficient_evidence");

  // 8. The 5th resolved sample crosses the threshold; a real qualitative state becomes reportable.
  await openCalibrationPrediction({ studentId: profile.id, conceptId: target.id, rating: 5 }, { supabase });
  const fifth = await recordScoredOutcomeWithRetention({ studentId: profile.id, conceptId: target.id, outcome: "correct", difficulty: "medium" }, { supabase });
  await resolveCalibrationPrediction({ studentId: profile.id, conceptId: target.id, sourceEventId: fifth.event.id }, { supabase });
  const atThreshold = await getCalibrationSignal(profile.id, { supabase });
  assert.equal(atThreshold.sampleCount, 5);
  assert.notEqual(atThreshold.state, "insufficient_evidence");
  assert.equal(atThreshold.state, "well_calibrated", "confidence 5/5 (predicted 1.0) matched by five correct answers (actual 1.0) is well-calibrated, not over/underconfident");

  // 9. Re-reading everything back (the "New Chat" / re-open scenario: a fresh read against the
  // same profile, not a fresh profile) shows every subsystem's state intact and mutually
  // consistent -- nothing was reset or corrupted by composing these subsystems together.
  const finalFoundation = await getConceptStatus(profile.id, foundation.id, { supabase });
  const finalTarget = await getConceptStatus(profile.id, target.id, { supabase });
  const finalProfile = await getOrCreateDefaultProfile({ supabase });
  assert.equal(finalFoundation.stage, "MASTERED");
  assert.notEqual(finalTarget.stage, "NEW");
  assert.equal(finalProfile.displayName, "Journey Learner");
  assert.equal((await getCalibrationSignal(profile.id, { supabase })).sampleCount, 5);
});
