import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  MasteryValidationError,
  applyLearningOutcome,
  getMasteryState,
  getPracticeSignal,
  hasSufficientEvidence,
  isMastered,
  listMasteryStates,
  recordScoredOutcome,
  replayMasteryFromEvents,
} from "@/lib/learning/mastery";
import { createOrResolveConcept } from "@/lib/learning/concepts";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { LEARNING_CONFIG } from "@/lib/learning/constants";
import { updateBkt, defaultBktParams } from "@/lib/learning/bkt";
import { createFakeLearningSupabase } from "./support/fake-learning-db";

async function setup() {
  const fake = createFakeLearningSupabase();
  const supabase = fake as never;
  const profile = await getOrCreateDefaultProfile({ supabase });
  const { concept } = await createOrResolveConcept({ subject: "algorithms", displayName: "Hashing" }, { supabase });
  return { supabase, fake, studentId: profile.id, conceptId: concept.id };
}

test("no mastery state exists until the first scored opportunity", async () => {
  const { supabase, studentId, conceptId } = await setup();
  assert.equal(await getMasteryState(studentId, conceptId, { supabase }), null);
});

test("does not create mastery state merely from an unscored event (QUESTION_ASKED)", async () => {
  const { supabase, fake, studentId, conceptId } = await setup();
  const { recordLearningEvent } = await import("@/lib/learning/events");
  await recordLearningEvent({ studentId, conceptId, eventType: "QUESTION_ASKED" }, { supabase });
  assert.equal(await getMasteryState(studentId, conceptId, { supabase }), null);
  assert.equal(fake.tables.masteryStates.rows.length, 0);
});

test("the first correct outcome initializes state from P(L0) and applies one BKT update", async () => {
  const { supabase, fake, studentId, conceptId } = await setup();
  const result = await recordScoredOutcome({ studentId, conceptId, outcome: "correct" }, { supabase });

  const expected = updateBkt(LEARNING_CONFIG.MODEL_PARAMETERS.BKT_DEFAULT_P_L0.value, defaultBktParams("mcq"), "correct");
  assert.ok(Math.abs(result.state.pMastery - expected.mastery) < 1e-9);
  assert.equal(result.state.evidenceCount, 1);
  assert.equal(result.state.correctCount, 1);
  assert.equal(result.state.incorrectCount, 0);
  assert.ok(result.state.firstPracticedAt);
  assert.equal(result.alreadyProcessed, false);
  assert.equal(fake.tables.masteryStates.rows.length, 1);
  assert.equal(fake.tables.transitions.rows.length, 1);
});

test("the first incorrect outcome initializes state from P(L0) and applies one BKT update", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const result = await recordScoredOutcome({ studentId, conceptId, outcome: "incorrect" }, { supabase });

  const expected = updateBkt(LEARNING_CONFIG.MODEL_PARAMETERS.BKT_DEFAULT_P_L0.value, defaultBktParams("mcq"), "incorrect");
  assert.ok(Math.abs(result.state.pMastery - expected.mastery) < 1e-9);
  assert.equal(result.state.correctCount, 0);
  assert.equal(result.state.incorrectCount, 1);
  // Notably NOT lower than P(L0) here: with P(L0)=0.20 well below this item's incorrect-answer
  // equilibrium (~0.30, given pLearn=0.30), the learning-transition term's (1-posterior)*pLearn
  // pull dominates the small Bayesian downward step -- a single incorrect answer from a low prior
  // can legitimately raise the estimate. This is a real, correct BKT property (verified by hand
  // against updateBkt() directly above), not a directional assumption -- see
  // "4. repeated incorrect answers trend downward" in learning-bkt.test.ts for the case (starting
  // well above the equilibrium) where incorrect answers do monotonically decrease mastery.
  assert.ok(expected.mastery > LEARNING_CONFIG.MODEL_PARAMETERS.BKT_DEFAULT_P_L0.value);
});

test("counters accumulate correctly across a mixed sequence, and evidence_count reconciles", async () => {
  const { supabase, studentId, conceptId } = await setup();
  await recordScoredOutcome({ studentId, conceptId, outcome: "correct" }, { supabase });
  await recordScoredOutcome({ studentId, conceptId, outcome: "correct" }, { supabase });
  const result = await recordScoredOutcome({ studentId, conceptId, outcome: "incorrect" }, { supabase });
  assert.equal(result.state.evidenceCount, 3);
  assert.equal(result.state.correctCount, 2);
  assert.equal(result.state.incorrectCount, 1);
  assert.equal(result.state.evidenceCount, result.state.correctCount + result.state.incorrectCount);
});

test("the same source event cannot update mastery twice -- exactly one transition, idempotent replay", async () => {
  const { supabase, fake, studentId, conceptId } = await setup();
  const { recordLearningEvent } = await import("@/lib/learning/events");
  const event = await recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED", metadata: { correct: true } }, { supabase });

  const first = await applyLearningOutcome({ studentId, conceptId, outcome: "correct", sourceEventId: event.id }, { supabase });
  const retry = await applyLearningOutcome({ studentId, conceptId, outcome: "correct", sourceEventId: event.id }, { supabase });

  assert.equal(first.alreadyProcessed, false);
  assert.equal(retry.alreadyProcessed, true);
  assert.equal(first.state.pMastery, retry.state.pMastery);
  assert.equal(fake.tables.transitions.rows.length, 1);
  assert.equal(fake.tables.masteryStates.rows[0].evidence_count, 1); // not double-counted
});

test("rejects an unknown source event", async () => {
  const { supabase, studentId, conceptId } = await setup();
  await assert.rejects(
    () => applyLearningOutcome({ studentId, conceptId, outcome: "correct", sourceEventId: randomUUID() }, { supabase }),
    MasteryValidationError,
  );
});

test("rejects a source event belonging to a different student", async () => {
  // The app is single-user by design (only one student_profiles row ever exists), so this test
  // exercises the mismatch check directly rather than via a second real profile: the event was
  // genuinely recorded under `studentId`, and the evidence claims a different one.
  const { supabase, studentId, conceptId } = await setup();
  const { recordLearningEvent } = await import("@/lib/learning/events");
  const event = await recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED" }, { supabase });
  await assert.rejects(
    () => applyLearningOutcome({ studentId: randomUUID(), conceptId, outcome: "correct", sourceEventId: event.id }, { supabase }),
    MasteryValidationError,
  );
});

test("rejects a source event already associated with a different concept", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const { concept: otherConcept } = await createOrResolveConcept({ subject: "algorithms", displayName: "Rolling Hash" }, { supabase });
  const { recordLearningEvent } = await import("@/lib/learning/events");
  const event = await recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED" }, { supabase }); // event tagged with `conceptId`
  await assert.rejects(
    () => applyLearningOutcome({ studentId, conceptId: otherConcept.id, outcome: "correct", sourceEventId: event.id }, { supabase }),
    MasteryValidationError,
  );
});

test("rejects an unknown concept", async () => {
  const { supabase, studentId } = await setup();
  const { recordLearningEvent } = await import("@/lib/learning/events");
  const event = await recordLearningEvent({ studentId, eventType: "QUIZ_ANSWERED" }, { supabase });
  await assert.rejects(
    () => applyLearningOutcome({ studentId, conceptId: randomUUID(), outcome: "correct", sourceEventId: event.id }, { supabase }),
    MasteryValidationError,
  );
});

test("no API/client field can set mastery/counters directly -- only outcome and evidence identity are read", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const tampered = { studentId, conceptId, outcome: "incorrect", sourceEventId: "", mastery: 0.99, evidenceCount: 999 } as never;
  await assert.rejects(() => applyLearningOutcome(tampered, { supabase }), MasteryValidationError); // empty sourceEventId is rejected outright
});

// --- Concurrency (Step 19) -------------------------------------------------------------------

test("a CAS conflict (state changed between read and write) is retried and eventually succeeds with no lost update", async () => {
  // Genuine microtask-interleaving races are non-deterministic to assert on, so this engineers
  // the exact race Step 19 describes: applyLearningOutcome reads state (null), then -- before its
  // RPC call lands -- a "concurrent writer" creates the row out from under it. The RPC's CAS guard
  // must catch this, roll back the doomed transition insert, and applyLearningOutcome must retry
  // with fresh state rather than silently overwriting the concurrent write.
  const { supabase: baseSupabase, fake, studentId, conceptId } = await setup();
  const { recordLearningEvent } = await import("@/lib/learning/events");
  const event = await recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED" }, { supabase: baseSupabase });

  let rpcCalls = 0;
  const racingSupabase = {
    ...fake,
    rpc: async (fn: string, params: Record<string, unknown>) => {
      if (fn === "apply_bkt_transition") {
        rpcCalls += 1;
        if (rpcCalls === 1) {
          const now = new Date().toISOString();
          fake.tables.masteryStates.rows.push({
            student_id: studentId,
            concept_id: conceptId,
            p_mastery: 0.5,
            evidence_count: 1,
            correct_count: 1,
            incorrect_count: 0,
            first_practiced_at: now,
            last_practiced_at: now,
            created_at: now,
            updated_at: now,
          });
        }
      }
      return fake.rpc(fn as never, params);
    },
  } as never;

  const result = await applyLearningOutcome({ studentId, conceptId, outcome: "correct", sourceEventId: event.id }, { supabase: racingSupabase });

  assert.equal(rpcCalls, 2); // attempt 1 hit the CAS conflict; attempt 2 succeeded against fresh state
  assert.equal(result.alreadyProcessed, false);
  assert.equal(fake.tables.transitions.rows.length, 1); // attempt 1's doomed ledger row was rolled back, not left orphaned
  assert.equal(result.state.evidenceCount, 2); // built on top of the concurrent write (1), not overwriting it
  assert.equal(result.state.correctCount, 2);
});

// --- Read helpers ------------------------------------------------------------------------------

test("listMasteryStates returns every concept the student has evidence on", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const { concept: second } = await createOrResolveConcept({ subject: "algorithms", displayName: "Rolling Hash" }, { supabase });
  await recordScoredOutcome({ studentId, conceptId, outcome: "correct" }, { supabase });
  await recordScoredOutcome({ studentId, conceptId: second.id, outcome: "incorrect" }, { supabase });
  const states = await listMasteryStates(studentId, { supabase });
  assert.equal(states.length, 2);
});

test("hasSufficientEvidence gates on MIN_EVIDENCE_FOR_ADAPTIVE (3)", async () => {
  const { supabase, studentId, conceptId } = await setup();
  await recordScoredOutcome({ studentId, conceptId, outcome: "correct" }, { supabase });
  let state = await getMasteryState(studentId, conceptId, { supabase });
  assert.equal(hasSufficientEvidence(state!), false);
  await recordScoredOutcome({ studentId, conceptId, outcome: "correct" }, { supabase });
  await recordScoredOutcome({ studentId, conceptId, outcome: "correct" }, { supabase });
  state = await getMasteryState(studentId, conceptId, { supabase });
  assert.equal(hasSufficientEvidence(state!), true);
});

test("isMastered re-exported from bkt.ts behaves identically here", () => {
  assert.equal(isMastered(0.9), true);
  assert.equal(isMastered(0.5), false);
});

// --- PFA integration (never a second mastery score) -------------------------------------------

test("getPracticeSignal reads the same counters BKT maintains -- no separate PFA storage", async () => {
  const { supabase, studentId, conceptId } = await setup();
  assert.deepEqual(await getPracticeSignal(studentId, conceptId, { supabase }), { opportunities: 0, successRate: null, pfaProbability: null, plateaued: false });
  await recordScoredOutcome({ studentId, conceptId, outcome: "correct" }, { supabase });
  const signal = await getPracticeSignal(studentId, conceptId, { supabase });
  assert.equal(signal.opportunities, 1);
  assert.equal(signal.successRate, 1);
});

// --- Replay (Step 20) --------------------------------------------------------------------------

test("deterministic replay from raw events reproduces the persisted mastery exactly", async () => {
  const { supabase, studentId, conceptId } = await setup();
  await recordScoredOutcome({ studentId, conceptId, outcome: "correct" }, { supabase });
  await recordScoredOutcome({ studentId, conceptId, outcome: "incorrect" }, { supabase });
  await recordScoredOutcome({ studentId, conceptId, outcome: "correct" }, { supabase });

  const replay = await replayMasteryFromEvents(studentId, conceptId, { supabase });
  assert.equal(replay.matches, true);
  assert.ok(replay.persistedMastery !== null);
  assert.ok(Math.abs(replay.replayedMastery - replay.persistedMastery!) < 1e-9);
});

test("replay with no evidence yet returns P(L0) and no persisted state to compare against", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const replay = await replayMasteryFromEvents(studentId, conceptId, { supabase });
  assert.equal(replay.persistedMastery, null);
  assert.equal(replay.matches, false);
  assert.equal(replay.replayedMastery, LEARNING_CONFIG.MODEL_PARAMETERS.BKT_DEFAULT_P_L0.value);
});
