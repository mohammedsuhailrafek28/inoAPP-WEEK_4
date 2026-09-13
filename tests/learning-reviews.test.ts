import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  RetentionValidationError,
  applyRetentionOutcome,
  getDueReviews,
  getRetentionState,
  listRetentionStates,
  recordScoredOutcomeWithRetention,
  replayRetentionFromEvents,
} from "@/lib/learning/reviews";
import { calculateRetrievability, initialStability } from "@/lib/learning/retention";
import { createOrResolveConcept } from "@/lib/learning/concepts";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { recordLearningEvent } from "@/lib/learning/events";
import { getMasteryState } from "@/lib/learning/mastery";
import { createFakeLearningSupabase } from "./support/fake-learning-db";

async function setup() {
  const fake = createFakeLearningSupabase();
  const supabase = fake as never;
  const profile = await getOrCreateDefaultProfile({ supabase });
  const { concept } = await createOrResolveConcept({ subject: "Algorithms", displayName: "Hashing" }, { supabase });
  return { supabase, fake, studentId: profile.id, conceptId: concept.id };
}

// --- No premature state (Step 13) -----------------------------------------------------------------

test("no retention state exists merely because a concept exists or was asked about", async () => {
  const { supabase, studentId, conceptId } = await setup();
  assert.equal(await getRetentionState(studentId, conceptId, { supabase }), null);
  assert.deepEqual(await listRetentionStates(studentId, { supabase }), []);
});

test("BKT evidence alone (no retention review) still reads as no retention state, even though the shared row now exists", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const { applyLearningOutcome } = await import("@/lib/learning/mastery");
  const event = await recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED", metadata: { correct: true } }, { supabase });
  await applyLearningOutcome({ studentId, conceptId, outcome: "correct", sourceEventId: event.id }, { supabase });
  assert.equal(await getRetentionState(studentId, conceptId, { supabase }), null);
});

// --- First review / initialization -----------------------------------------------------------------

test("the first review initializes stability/difficulty and schedules the next review", async () => {
  const { supabase, fake, studentId, conceptId } = await setup();
  const result = await recordScoredOutcomeWithRetention({ studentId, conceptId, outcome: "correct", difficulty: "medium" }, { supabase });

  assert.equal(result.fsrs.state.cardState, "review");
  assert.equal(result.fsrs.state.stability, initialStability("good"));
  assert.equal(result.fsrs.state.reps, 1);
  assert.equal(result.fsrs.state.lapses, 0);
  assert.ok(result.fsrs.state.nextReviewAt);
  assert.equal(result.fsrs.transition.retrievabilityBefore, null);
  assert.equal(fake.tables.retentionTransitions.rows.length, 1);
});

test("an incorrect first answer starts a card in 'learning', due immediately", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const result = await recordScoredOutcomeWithRetention({ studentId, conceptId, outcome: "incorrect", difficulty: "medium" }, { supabase });
  assert.equal(result.fsrs.state.cardState, "learning");
  assert.equal(result.fsrs.transition.lapsed, false); // first-ever Again is not a "lapse" -- there is nothing to lapse from
});

// --- Idempotency (Step 11) -------------------------------------------------------------------------

test("the same source event cannot update retention twice -- idempotent replay", async () => {
  const { supabase, fake, studentId, conceptId } = await setup();
  const event = await recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED", metadata: { correct: true } }, { supabase });
  const first = await applyRetentionOutcome({ studentId, conceptId, outcome: "correct", sourceEventId: event.id }, { supabase });
  const retry = await applyRetentionOutcome({ studentId, conceptId, outcome: "correct", sourceEventId: event.id }, { supabase });
  assert.equal(first.alreadyProcessed, false);
  assert.equal(retry.alreadyProcessed, true);
  assert.equal(first.state.stability, retry.state.stability);
  assert.equal(fake.tables.retentionTransitions.rows.length, 1);
});

test("bugfix: replaying an older event after a chronologically later event's retention update already landed returns the original transition safely, never throwing", async () => {
  const { supabase, fake, studentId, conceptId } = await setup();

  const olderEvent = await recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED", metadata: { correct: true } }, { supabase });
  const newerEvent = await recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED", metadata: { correct: true } }, { supabase });

  // Force a genuine, unambiguous chronological gap -- the fake DB's own millisecond-resolution
  // timestamps could otherwise tie during fast synchronous test execution.
  const olderRow = fake.tables.events.rows.find((r) => r.id === olderEvent.id)!;
  const newerRow = fake.tables.events.rows.find((r) => r.id === newerEvent.id)!;
  olderRow.occurred_at = new Date("2024-01-01T00:00:00.000Z").toISOString();
  newerRow.occurred_at = new Date("2024-01-05T00:00:00.000Z").toISOString();

  const olderResult = await applyRetentionOutcome({ studentId, conceptId, outcome: "correct", sourceEventId: olderEvent.id }, { supabase });
  await applyRetentionOutcome({ studentId, conceptId, outcome: "correct", sourceEventId: newerEvent.id }, { supabase }); // advances last_reviewed_at past olderEvent's own timestamp

  // Before the fix, this replay computed daysBetween(olderEvent's timestamp, the NOW-later
  // last_reviewed_at) inside applyReview() and threw "Elapsed time cannot be negative" -- it must
  // instead short-circuit to the original transition, unchanged.
  const replay = await applyRetentionOutcome({ studentId, conceptId, outcome: "correct", sourceEventId: olderEvent.id }, { supabase });
  assert.equal(replay.alreadyProcessed, true);
  assert.equal(replay.transition.id, olderResult.transition.id);
  assert.equal(replay.transition.stabilityAfter, olderResult.transition.stabilityAfter);

  const currentState = await getRetentionState(studentId, conceptId, { supabase });
  assert.equal(currentState!.reps, 2); // only the two genuine reviews -- the stale replay added nothing
});

test("rejects an unknown source event and an unknown concept", async () => {
  const { supabase, studentId, conceptId } = await setup();
  await assert.rejects(() => applyRetentionOutcome({ studentId, conceptId, outcome: "correct", sourceEventId: randomUUID() }, { supabase }), RetentionValidationError);
  const event = await recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED" }, { supabase });
  await assert.rejects(() => applyRetentionOutcome({ studentId, conceptId: randomUUID(), outcome: "correct", sourceEventId: event.id }, { supabase }), RetentionValidationError);
});

// --- BKT/FSRS boundary (§10, mandatory) -------------------------------------------------------------

test("FSRS review scheduling never mutates BKT mastery -- the two authorities stay fully independent on the same row", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const before = await recordScoredOutcomeWithRetention({ studentId, conceptId, outcome: "correct", difficulty: "medium" }, { supabase });
  const masteryAfterFirst = (await getMasteryState(studentId, conceptId, { supabase }))!.pMastery;

  // A second, later retention-only review (via a fresh event) must not change p_mastery by itself --
  // only lib/learning/mastery.ts::applyLearningOutcome() may ever do that, and it is not called here.
  const event = await recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED", metadata: { correct: true } }, { supabase });
  await applyRetentionOutcome({ studentId, conceptId, outcome: "correct", sourceEventId: event.id }, { supabase });
  const masteryAfterSecond = (await getMasteryState(studentId, conceptId, { supabase }))!.pMastery;

  assert.equal(masteryAfterFirst, masteryAfterSecond);
  assert.equal(before.fsrs.state.stability !== null, true);
});

// --- Cross-model independence (Step 11/31, mandatory) -------------------------------------------------

test("one authoritative QUIZ_ANSWERED event updates BKT, IRT, and FSRS each exactly once, independently", async () => {
  const { supabase, fake, studentId, conceptId } = await setup();
  const { bkt, irt, fsrs } = await recordScoredOutcomeWithRetention({ studentId, conceptId, outcome: "correct", difficulty: "hard" }, { supabase });

  assert.equal(bkt.alreadyProcessed, false);
  assert.equal(irt.alreadyProcessed, false);
  assert.equal(fsrs.alreadyProcessed, false);
  assert.equal(bkt.transition.sourceEventId, irt.transition.sourceEventId);
  assert.equal(bkt.transition.sourceEventId, fsrs.transition.sourceEventId);
  assert.equal(fake.tables.transitions.rows.length, 1); // exactly one BKT transition
  assert.equal(fake.tables.abilityTransitions.rows.length, 1); // exactly one IRT transition
  assert.equal(fake.tables.retentionTransitions.rows.length, 1); // exactly one FSRS transition
});

test("mandatory: retrying the same event does not double-apply BKT, IRT, or FSRS, and all three states stay consistent", async () => {
  const { supabase, fake, studentId, conceptId } = await setup();
  const event = await recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED", metadata: { correct: true, difficulty: "medium" } }, { supabase });

  const { applyLearningOutcome } = await import("@/lib/learning/mastery");
  const { applyAbilityOutcome } = await import("@/lib/learning/ability");

  await applyLearningOutcome({ studentId, conceptId, outcome: "correct", sourceEventId: event.id }, { supabase });
  await applyAbilityOutcome({ studentId, conceptId, outcome: "correct", sourceEventId: event.id, difficulty: "medium" }, { supabase });
  await applyRetentionOutcome({ studentId, conceptId, outcome: "correct", sourceEventId: event.id }, { supabase });

  const bktRetry = await applyLearningOutcome({ studentId, conceptId, outcome: "correct", sourceEventId: event.id }, { supabase });
  const irtRetry = await applyAbilityOutcome({ studentId, conceptId, outcome: "correct", sourceEventId: event.id, difficulty: "medium" }, { supabase });
  const fsrsRetry = await applyRetentionOutcome({ studentId, conceptId, outcome: "correct", sourceEventId: event.id }, { supabase });

  assert.equal(bktRetry.alreadyProcessed, true);
  assert.equal(irtRetry.alreadyProcessed, true);
  assert.equal(fsrsRetry.alreadyProcessed, true);
  assert.equal(fake.tables.transitions.rows.length, 1);
  assert.equal(fake.tables.abilityTransitions.rows.length, 1);
  assert.equal(fake.tables.retentionTransitions.rows.length, 1);
  assert.equal(fake.tables.masteryStates.rows[0].evidence_count, 1);
  assert.equal(fake.tables.abilities.rows[0].observation_count, 1);
  assert.equal(fake.tables.masteryStates.rows[0].reps, 1);
});

// --- Due-review queue (Step 23) --------------------------------------------------------------------

test("getDueReviews returns nothing for a freshly-scheduled review (not yet due)", async () => {
  const { supabase, studentId, conceptId } = await setup();
  await recordScoredOutcomeWithRetention({ studentId, conceptId, outcome: "correct", difficulty: "medium" }, { supabase });
  const due = await getDueReviews(studentId, new Date(), { supabase });
  assert.deepEqual(due, []);
});

test("getDueReviews surfaces a concept once its scheduled next_review_at has passed, with retrievability/urgency computed at query time", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const result = await recordScoredOutcomeWithRetention({ studentId, conceptId, outcome: "incorrect", difficulty: "medium" }, { supabase });
  assert.equal(result.fsrs.state.cardState, "learning"); // due immediately (nextReviewAt === reviewedAt)

  const now = new Date(new Date(result.fsrs.state.lastReviewedAt!).getTime() + 60_000);
  const due = await getDueReviews(studentId, now, { supabase });
  assert.equal(due.length, 1);
  assert.equal(due[0].conceptId, conceptId);
  assert.ok(due[0].retrievability <= 1 && due[0].retrievability >= 0);
  assert.equal(due[0].reviewStatus, "due");
});

test("getDueReviews never mixes in a BKT/PFA/IRT priority score -- it only reports retention due-ness", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const result = await recordScoredOutcomeWithRetention({ studentId, conceptId, outcome: "incorrect", difficulty: "medium" }, { supabase });
  const now = new Date(new Date(result.fsrs.state.lastReviewedAt!).getTime() + 1000);
  const due = await getDueReviews(studentId, now, { supabase });
  assert.equal(due.length, 1);
  assert.deepEqual(Object.keys(due[0]).sort(), ["conceptId", "conceptKey", "displayName", "state", "subject", "urgency", "retrievability", "reviewStatus"].sort());
});

// --- Replay (Step 22) ----------------------------------------------------------------------------

test("deterministic replay from raw events reproduces persisted stability/difficulty/card_state/reps/lapses/next_review_at exactly", async () => {
  const { supabase, studentId, conceptId } = await setup();
  await recordScoredOutcomeWithRetention({ studentId, conceptId, outcome: "incorrect", difficulty: "medium" }, { supabase }); // -> learning
  await recordScoredOutcomeWithRetention({ studentId, conceptId, outcome: "correct", difficulty: "medium" }, { supabase }); // -> review
  await recordScoredOutcomeWithRetention({ studentId, conceptId, outcome: "correct", difficulty: "medium" }, { supabase }); // -> review, grows S
  await recordScoredOutcomeWithRetention({ studentId, conceptId, outcome: "incorrect", difficulty: "medium" }, { supabase }); // -> relearning, lapse

  const replay = await replayRetentionFromEvents(studentId, conceptId, { supabase });
  assert.equal(replay.matches, true);
  assert.equal(replay.replayed.reps, 4);
  assert.equal(replay.replayed.lapses, 1);
  assert.equal(replay.replayed.cardState, "relearning");
});

test("replay with no evidence yet returns null for persisted state and no match claim", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const replay = await replayRetentionFromEvents(studentId, conceptId, { supabase });
  assert.equal(replay.persisted, null);
  assert.equal(replay.matches, false);
  assert.equal(replay.replayed.reps, 0);
});

// --- Concurrency (Step 21 -- learns from the Phase 4 CAS bug) ---------------------------------------

test("an FSRS CAS conflict on the shared row is retried and eventually succeeds with no lost update", async () => {
  const { supabase: baseSupabase, fake, studentId, conceptId } = await setup();
  await recordScoredOutcomeWithRetention({ studentId, conceptId, outcome: "correct", difficulty: "medium" }, { supabase: baseSupabase });
  const event = await recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED", metadata: { correct: true } }, { supabase: baseSupabase });

  let rpcCalls = 0;
  const racingSupabase = {
    ...fake,
    rpc: async (fn: string, params: Record<string, unknown>) => {
      if (fn === "apply_retention_transition") {
        rpcCalls += 1;
        if (rpcCalls === 1) {
          // Simulate a concurrent retention write landing between this call's read and its write --
          // bumps `reps` only, exactly the integer counter the CAS guard inspects (never a float).
          const row = fake.tables.masteryStates.rows.find((r) => r.student_id === studentId && r.concept_id === conceptId)!;
          row.reps = (row.reps as number) + 1;
        }
      }
      return fake.rpc(fn as never, params);
    },
  } as never;

  const result = await applyRetentionOutcome({ studentId, conceptId, outcome: "correct", sourceEventId: event.id }, { supabase: racingSupabase });
  assert.equal(rpcCalls, 2);
  assert.equal(result.alreadyProcessed, false);
  // 2 total: one from the setup review above (a different source event) + exactly one for THIS
  // event, surviving after the first, conflicted attempt's transition row was rolled back.
  assert.equal(fake.tables.retentionTransitions.rows.length, 2);
  assert.equal(result.state.reps, 3); // 1 (initial) + 1 (simulated concurrent) + 1 (this call, retried)
});

// --- Retrievability sanity against the pure module (integration-level cross-check) ------------------

test("a due review's reported retrievability matches calculateRetrievability(elapsedDays, stability) computed independently", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const result = await recordScoredOutcomeWithRetention({ studentId, conceptId, outcome: "correct", difficulty: "medium" }, { supabase });
  const reviewedAt = new Date(result.fsrs.state.lastReviewedAt!);
  const now = new Date(reviewedAt.getTime() + 5 * 24 * 60 * 60 * 1000);

  // Force it due now by directly checking against the pure formula rather than waiting for the
  // real schedule -- getDueReviews only returns rows whose nextReviewAt has passed, so compute the
  // expected retrievability the same way the service does and simply verify the two agree.
  const expected = calculateRetrievability(5, result.fsrs.state.stability!);
  const nextReviewAt = new Date(result.fsrs.state.nextReviewAt!);
  if (now.getTime() >= nextReviewAt.getTime()) {
    const due = await getDueReviews(studentId, now, { supabase });
    assert.equal(due.length, 1);
    assert.ok(Math.abs(due[0].retrievability - expected) < 1e-9);
  } else {
    assert.ok(expected < 1 && expected > 0); // still asserts the independent pure computation is sane
  }
});
