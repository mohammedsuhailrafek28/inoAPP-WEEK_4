import assert from "node:assert/strict";
import test from "node:test";
import { getPrerequisiteReadiness } from "@/lib/learning/readiness";
import { recordScoredOutcome } from "@/lib/learning/mastery";
import { recordScoredOutcomeWithRetention } from "@/lib/learning/reviews";
import { createOrResolveConcept, addPrerequisite } from "@/lib/learning/concepts";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { createFakeLearningSupabase } from "./support/fake-learning-db";

async function setup() {
  const fake = createFakeLearningSupabase();
  const supabase = fake as never;
  const profile = await getOrCreateDefaultProfile({ supabase });
  return { supabase, fake, studentId: profile.id };
}

test("a prerequisite with no BKT evidence at all blocks the target -- 'no_evidence'", async () => {
  const { supabase, studentId } = await setup();
  const { concept: a } = await createOrResolveConcept({ subject: "Algorithms", displayName: "Hashing" }, { supabase });
  const { concept: b } = await createOrResolveConcept({ subject: "Algorithms", displayName: "Rolling Hash" }, { supabase });
  await addPrerequisite(b.id, a.id, { supabase });

  const readiness = await getPrerequisiteReadiness(studentId, b.id, { supabase });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.directPrerequisites.length, 1);
  assert.equal(readiness.directPrerequisites[0].status, "no_evidence");
  assert.equal(readiness.directPrerequisites[0].blockerReasonCode, "PREREQUISITE_NO_EVIDENCE");
  assert.equal(readiness.blockers.length, 1);
  assert.equal(readiness.blockers[0].conceptId, a.id);
});

test("high mastery from too few opportunities is NOT securely ready -- evidence sufficiency gates before mastery (Step 4)", async () => {
  const { supabase, studentId } = await setup();
  const { concept: a } = await createOrResolveConcept({ subject: "Algorithms", displayName: "Hashing" }, { supabase });
  const { concept: b } = await createOrResolveConcept({ subject: "Algorithms", displayName: "Rolling Hash" }, { supabase });
  await addPrerequisite(b.id, a.id, { supabase });

  // Two correct answers from P(L0)=0.20 with default MCQ params pushes p_mastery above 0.70 --
  // exactly the "one lucky streak, insufficient evidence" case Step 4 explicitly warns against.
  await recordScoredOutcome({ studentId, conceptId: a.id, outcome: "correct" }, { supabase });
  const second = await recordScoredOutcome({ studentId, conceptId: a.id, outcome: "correct" }, { supabase });
  assert.ok(second.state.pMastery >= 0.70, "test setup expects mastery to have spiked above the ready threshold");
  assert.ok(second.state.evidenceCount < 3, "test setup expects evidence to still be below the sufficiency floor");

  const readiness = await getPrerequisiteReadiness(studentId, b.id, { supabase });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.directPrerequisites[0].status, "insufficient_evidence");
  assert.equal(readiness.directPrerequisites[0].blockerReasonCode, "PREREQUISITE_EVIDENCE_INSUFFICIENT");
});

test("mastered with sufficient evidence -> target is ready", async () => {
  const { supabase, studentId } = await setup();
  const { concept: a } = await createOrResolveConcept({ subject: "Algorithms", displayName: "Hashing" }, { supabase });
  const { concept: b } = await createOrResolveConcept({ subject: "Algorithms", displayName: "Rolling Hash" }, { supabase });
  await addPrerequisite(b.id, a.id, { supabase });

  await recordScoredOutcome({ studentId, conceptId: a.id, outcome: "correct" }, { supabase });
  await recordScoredOutcome({ studentId, conceptId: a.id, outcome: "correct" }, { supabase });
  const third = await recordScoredOutcome({ studentId, conceptId: a.id, outcome: "correct" }, { supabase });
  assert.ok(third.state.pMastery >= 0.70 && third.state.evidenceCount >= 3);

  const readiness = await getPrerequisiteReadiness(studentId, b.id, { supabase });
  assert.equal(readiness.ready, true);
  assert.equal(readiness.directPrerequisites[0].status, "ready");
  assert.equal(readiness.directPrerequisites[0].blockerReasonCode, null);
  assert.deepEqual(readiness.blockers, []);
});

test("not mastered with sufficient evidence -> 'not_mastered', not merely 'blocked'", async () => {
  const { supabase, studentId } = await setup();
  const { concept: a } = await createOrResolveConcept({ subject: "Algorithms", displayName: "Hashing" }, { supabase });
  const { concept: b } = await createOrResolveConcept({ subject: "Algorithms", displayName: "Rolling Hash" }, { supabase });
  await addPrerequisite(b.id, a.id, { supabase });

  await recordScoredOutcome({ studentId, conceptId: a.id, outcome: "incorrect" }, { supabase });
  await recordScoredOutcome({ studentId, conceptId: a.id, outcome: "incorrect" }, { supabase });
  const third = await recordScoredOutcome({ studentId, conceptId: a.id, outcome: "incorrect" }, { supabase });
  assert.ok(third.state.pMastery < 0.70 && third.state.evidenceCount >= 3);

  const readiness = await getPrerequisiteReadiness(studentId, b.id, { supabase });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.directPrerequisites[0].status, "not_mastered");
  assert.equal(readiness.directPrerequisites[0].blockerReasonCode, "PREREQUISITE_NOT_MASTERED");
});

test("multi-level chain: C depends on B depends on A -- C is only ready once B itself is ready", async () => {
  const { supabase, studentId } = await setup();
  const { concept: a } = await createOrResolveConcept({ subject: "Algorithms", displayName: "Hashing" }, { supabase });
  const { concept: b } = await createOrResolveConcept({ subject: "Algorithms", displayName: "Rolling Hash" }, { supabase });
  const { concept: c } = await createOrResolveConcept({ subject: "Algorithms", displayName: "Rabin-Karp" }, { supabase });
  await addPrerequisite(b.id, a.id, { supabase });
  await addPrerequisite(c.id, b.id, { supabase });

  // A is mastered, but B (C's direct prerequisite) has no evidence -- C must still be blocked,
  // even though A (the deeper ancestor) is fine. Direct-prerequisite-only checking (§6) means C's
  // readiness call doesn't even see A directly -- it's B's own unreadiness that blocks C.
  for (let i = 0; i < 3; i++) await recordScoredOutcome({ studentId, conceptId: a.id, outcome: "correct" }, { supabase });

  const cReadiness = await getPrerequisiteReadiness(studentId, c.id, { supabase });
  assert.equal(cReadiness.ready, false);
  assert.equal(cReadiness.directPrerequisites.length, 1);
  assert.equal(cReadiness.directPrerequisites[0].conceptId, b.id);
  assert.equal(cReadiness.directPrerequisites[0].status, "no_evidence");

  // Now master B too -- C becomes ready.
  for (let i = 0; i < 3; i++) await recordScoredOutcome({ studentId, conceptId: b.id, outcome: "correct" }, { supabase });
  const cReadinessAfter = await getPrerequisiteReadiness(studentId, c.id, { supabase });
  assert.equal(cReadinessAfter.ready, true);
});

test("multiple prerequisites: one blocker among many is reported, the mastered one is not", async () => {
  const { supabase, studentId } = await setup();
  const { concept: a1 } = await createOrResolveConcept({ subject: "Algorithms", displayName: "Arrays" }, { supabase });
  const { concept: a2 } = await createOrResolveConcept({ subject: "Algorithms", displayName: "Recursion" }, { supabase });
  const { concept: b } = await createOrResolveConcept({ subject: "Algorithms", displayName: "Divide And Conquer" }, { supabase });
  await addPrerequisite(b.id, a1.id, { supabase });
  await addPrerequisite(b.id, a2.id, { supabase });

  for (let i = 0; i < 3; i++) await recordScoredOutcome({ studentId, conceptId: a1.id, outcome: "correct" }, { supabase });
  // a2 has no evidence at all.

  const readiness = await getPrerequisiteReadiness(studentId, b.id, { supabase });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.directPrerequisites.length, 2);
  assert.equal(readiness.blockers.length, 1);
  assert.equal(readiness.blockers[0].conceptId, a2.id);
});

test("review-due behavior: high mastery + FSRS review due is 'ready_but_review_due', still counts as ready -- never demoted to unmastered (Step 5)", async () => {
  const { supabase, studentId } = await setup();
  const { concept: a } = await createOrResolveConcept({ subject: "Algorithms", displayName: "Hashing" }, { supabase });
  const { concept: b } = await createOrResolveConcept({ subject: "Algorithms", displayName: "Rolling Hash" }, { supabase });
  await addPrerequisite(b.id, a.id, { supabase });

  // Master A with sufficient evidence, and give it a retention review that is due immediately (an
  // incorrect-then-review-scheduled path -- retention's own "learning" state schedules due now).
  for (let i = 0; i < 3; i++) await recordScoredOutcomeWithRetention({ studentId, conceptId: a.id, outcome: "correct", difficulty: "medium" }, { supabase });
  await recordScoredOutcomeWithRetention({ studentId, conceptId: a.id, outcome: "incorrect", difficulty: "medium" }, { supabase }); // -> relearning, lapse, due now

  const readiness = await getPrerequisiteReadiness(studentId, b.id, { supabase });
  assert.equal(readiness.directPrerequisites[0].status, "ready_but_review_due");
  assert.equal(readiness.directPrerequisites[0].reviewStatus, "due");
  assert.equal(readiness.directPrerequisites[0].blockerReasonCode, null);
  assert.equal(readiness.ready, true); // still ready overall -- review-due is additive, not a blocker
  assert.deepEqual(readiness.blockers, []);
});

test("deterministic blocker order matches Phase 2's topological learning order", async () => {
  const { supabase, studentId } = await setup();
  const { concept: a1 } = await createOrResolveConcept({ subject: "Algorithms", displayName: "Arrays" }, { supabase });
  const { concept: a2 } = await createOrResolveConcept({ subject: "Algorithms", displayName: "Recursion" }, { supabase });
  const { concept: b } = await createOrResolveConcept({ subject: "Algorithms", displayName: "Divide And Conquer" }, { supabase });
  await addPrerequisite(b.id, a1.id, { supabase });
  await addPrerequisite(b.id, a2.id, { supabase });
  // Neither a1 nor a2 has any evidence -- both are blockers.

  const first = await getPrerequisiteReadiness(studentId, b.id, { supabase });
  const second = await getPrerequisiteReadiness(studentId, b.id, { supabase });
  assert.equal(first.blockers.length, 2);
  assert.deepEqual(
    first.blockers.map((blocker) => blocker.conceptId),
    second.blockers.map((blocker) => blocker.conceptId),
  );
  assert.deepEqual(
    first.remediationOrder.map((node) => node.id),
    second.remediationOrder.map((node) => node.id),
  );
});
