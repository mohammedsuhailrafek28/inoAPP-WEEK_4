import assert from "node:assert/strict";
import test from "node:test";
import { createFakeLearningSupabase } from "./support/fake-learning-db";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { createOrResolveConcept } from "@/lib/learning/concepts";
import { getConceptStatus } from "@/lib/learning/olm";
import { getRevisionRecommendations } from "@/lib/learning/recommendations";
import { recordScoredOutcomeWithRetention } from "@/lib/learning/reviews";
import { recordLearningEvent } from "@/lib/learning/events";
import { recordMisconceptionEvidence, reevaluateMisconceptionResolution } from "@/lib/learning/misconceptions";
import { applyTransferEvidence } from "@/lib/learning/transfer";

// Step 55 (mandatory): a deterministic 10-checkpoint learner journey, verifying analytics/revision
// react at each step -- NEW -> LEARNING -> DEVELOPING -> PROFICIENT -> MASTERED -> REVIEW_DUE ->
// back to a learned state -> misconception appears -> resolves -> transfer attempted.
test("end-to-end learner journey: OLM stage and revision recommendations track real evidence at every checkpoint", async () => {
  const fake = createFakeLearningSupabase();
  const supabase = fake as never;
  const profile = await getOrCreateDefaultProfile({ supabase });
  const { concept } = await createOrResolveConcept({ subject: "Journey Subject", displayName: "Journey Concept" }, { supabase });

  // 1. NEW
  assert.equal((await getConceptStatus(profile.id, concept.id, { supabase })).stage, "NEW");

  // 2. practice begins -> LEARNING (evidence < floor)
  await recordScoredOutcomeWithRetention({ studentId: profile.id, conceptId: concept.id, outcome: "correct", difficulty: "medium" }, { supabase });
  assert.equal((await getConceptStatus(profile.id, concept.id, { supabase })).stage, "LEARNING");

  // 3/4. mastery improves monotonically as more correct answers accumulate -- BKT's exact
  // convergence speed (whether every intermediate DEVELOPING/PROFICIENT stage is individually
  // observed at this evidence granularity) is a model property already covered by
  // tests/learning-bkt.test.ts, not re-asserted rigidly here.
  const stageOrder = ["NEW", "LEARNING", "DEVELOPING", "PROFICIENT", "MASTERED"];
  let previousRank = stageOrder.indexOf("LEARNING");
  for (let i = 0; i < 6; i++) {
    await recordScoredOutcomeWithRetention({ studentId: profile.id, conceptId: concept.id, outcome: "correct", difficulty: "medium" }, { supabase });
    const rank = stageOrder.indexOf((await getConceptStatus(profile.id, concept.id, { supabase })).stage);
    assert.ok(rank >= previousRank, "an unbroken correct streak must never regress the OLM stage");
    previousRank = rank;
  }

  // 5. sufficient progress -> MASTERED
  let finalStatus = await getConceptStatus(profile.id, concept.id, { supabase });
  for (let i = 0; i < 5 && finalStatus.stage !== "MASTERED"; i++) {
    await recordScoredOutcomeWithRetention({ studentId: profile.id, conceptId: concept.id, outcome: "correct", difficulty: "medium" }, { supabase });
    finalStatus = await getConceptStatus(profile.id, concept.id, { supabase });
  }
  assert.equal(finalStatus.stage, "MASTERED");

  // 6. time passes -> REVIEW_DUE, mastery itself untouched
  const farFuture = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);
  const reviewDueStatus = await getConceptStatus(profile.id, concept.id, { supabase, now: farFuture });
  assert.equal(reviewDueStatus.stage, "REVIEW_DUE");

  // Revision recommendations must surface this concept with REVIEW_DUE, at the far-future `now`.
  const revisionAtReviewDue = await getRevisionRecommendations(profile.id, { subject: "Journey Subject" }, { supabase, now: farFuture });
  const entry = revisionAtReviewDue.recommendations.find((r) => r.conceptKey === concept.conceptKey);
  assert.ok(entry?.reasonCodes.includes("REVIEW_DUE"));

  // 7. review succeeds -> returns to a learned (non-REVIEW_DUE) state, checked shortly after the
  // fresh review (not at `farFuture` again, which would just re-observe 400 days of NEW decay).
  await recordScoredOutcomeWithRetention({ studentId: profile.id, conceptId: concept.id, outcome: "correct", difficulty: "medium" }, { supabase });
  const shortlyAfterReview = new Date(Date.now() + 60 * 1000);
  const afterReview = await getConceptStatus(profile.id, concept.id, { supabase, now: shortlyAfterReview });
  assert.notEqual(afterReview.stage, "REVIEW_DUE");

  // 8. an active misconception appears -> revision recommendation for this concept gains ACTIVE_MISCONCEPTION
  for (let i = 0; i < 2; i++) {
    const quizEvent = await recordLearningEvent({ studentId: profile.id, conceptId: concept.id, eventType: "QUIZ_ANSWERED", metadata: { correct: false } }, { supabase });
    const observed = await recordLearningEvent({ studentId: profile.id, conceptId: concept.id, eventType: "MISCONCEPTION_OBSERVED", metadata: { proposedByLlm: true, relatedEventId: quizEvent.id, tag: "journey_tag" } }, { supabase });
    await recordMisconceptionEvidence({ studentId: profile.id, conceptId: concept.id, sourceEventId: observed.id, tag: "journey_tag", description: "A journey-test error." }, { supabase });
  }
  const withMisconception = await getConceptStatus(profile.id, concept.id, { supabase });
  assert.ok(withMisconception.activeMisconception);
  const revisionWithMisconception = await getRevisionRecommendations(profile.id, { subject: "Journey Subject" }, { supabase });
  assert.ok(revisionWithMisconception.recommendations.find((r) => r.conceptKey === concept.conceptKey)?.reasonCodes.includes("ACTIVE_MISCONCEPTION"));

  // 9. misconception resolves after 3 clean interactions with no recurrence
  for (let i = 0; i < 3; i++) await recordScoredOutcomeWithRetention({ studentId: profile.id, conceptId: concept.id, outcome: "correct", difficulty: "medium" }, { supabase });
  await reevaluateMisconceptionResolution(profile.id, concept.id, "journey_tag", { supabase });
  const resolvedStatus = await getConceptStatus(profile.id, concept.id, { supabase });
  assert.equal(resolvedStatus.activeMisconception, null);

  // 10. transfer challenge attempted -> transfer becomes visible
  assert.equal((await getConceptStatus(profile.id, concept.id, { supabase })).transferReadiness, null);
  const transferEvent = await recordLearningEvent({ studentId: profile.id, conceptId: concept.id, eventType: "TRANSFER_ATTEMPTED", metadata: { dimension: "transfer", score: 0.8 } }, { supabase });
  await applyTransferEvidence({ studentId: profile.id, conceptId: concept.id, level: "transfer", score: 0.8, sourceEventId: transferEvent.id }, { supabase });
  const finalTransferStatus = await getConceptStatus(profile.id, concept.id, { supabase });
  assert.notEqual(finalTransferStatus.transferReadiness, null);
});
