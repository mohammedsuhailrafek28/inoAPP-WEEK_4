import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  AbilityValidationError,
  applyAbilityOutcome,
  getAbility,
  hasSufficientAbilityEvidence,
  listAbilities,
  recordScoredOutcomeWithAbility,
  replayAbilityFromEvents,
} from "@/lib/learning/ability";
import { updateTheta, defaultTheta } from "@/lib/learning/irt";
import { createOrResolveConcept } from "@/lib/learning/concepts";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { recordLearningEvent } from "@/lib/learning/events";
import { createFakeLearningSupabase } from "./support/fake-learning-db";

async function setup() {
  const fake = createFakeLearningSupabase();
  const supabase = fake as never;
  const profile = await getOrCreateDefaultProfile({ supabase });
  const { concept } = await createOrResolveConcept({ subject: "Algorithms", displayName: "Hashing" }, { supabase });
  return { supabase, fake, studentId: profile.id, conceptId: concept.id, subject: concept.subject };
}

test("no ability exists until the first IRT-consumed opportunity", async () => {
  const { supabase, studentId, subject } = await setup();
  assert.equal(await getAbility(studentId, subject, { supabase }), null);
});

test("the first observation initializes theta from 0 and applies one Newton step", async () => {
  const { supabase, fake, studentId, conceptId, subject } = await setup();
  const result = await recordScoredOutcomeWithAbility({ studentId, conceptId, outcome: "correct", difficulty: "hard" }, { supabase });

  const expected = updateTheta(defaultTheta(), 0, 1.0, "correct");
  assert.ok(Math.abs(result.irt.ability.theta - expected.theta) < 1e-9);
  assert.equal(result.irt.ability.observationCount, 1);
  assert.equal(result.irt.ability.correctCount, 1);
  assert.equal(result.irt.alreadyProcessed, false);
  assert.equal(fake.tables.abilities.rows.length, 1);
  assert.equal(fake.tables.abilityTransitions.rows.length, 1);
  assert.equal(result.irt.ability.subject, subject);
});

test("subject is derived from learning_concepts.subject, never trusted from the caller or event metadata", async () => {
  const { supabase, studentId, conceptId, subject } = await setup();
  // Even if somehow asked to record with a bogus subject in surrounding context, applyAbilityOutcome
  // has no subject parameter at all -- it is structurally impossible to pass one in.
  const event = await recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED", metadata: { correct: true, difficulty: "medium" } }, { supabase });
  const result = await applyAbilityOutcome({ studentId, conceptId, outcome: "correct", sourceEventId: event.id, difficulty: "medium" }, { supabase });
  assert.equal(result.ability.subject, subject);
});

test("counters accumulate, and observation_count reconciles with correct+incorrect", async () => {
  const { supabase, studentId, conceptId } = await setup();
  await recordScoredOutcomeWithAbility({ studentId, conceptId, outcome: "correct", difficulty: "medium" }, { supabase });
  await recordScoredOutcomeWithAbility({ studentId, conceptId, outcome: "correct", difficulty: "medium" }, { supabase });
  const result = await recordScoredOutcomeWithAbility({ studentId, conceptId, outcome: "incorrect", difficulty: "medium" }, { supabase });
  assert.equal(result.irt.ability.observationCount, 3);
  assert.equal(result.irt.ability.correctCount, 2);
  assert.equal(result.irt.ability.incorrectCount, 1);
  assert.equal(result.irt.ability.observationCount, result.irt.ability.correctCount + result.irt.ability.incorrectCount);
});

test("the same source event cannot update ability twice -- idempotent replay", async () => {
  const { supabase, fake, studentId, conceptId } = await setup();
  const event = await recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED", metadata: { correct: true, difficulty: "easy" } }, { supabase });
  const first = await applyAbilityOutcome({ studentId, conceptId, outcome: "correct", sourceEventId: event.id, difficulty: "easy" }, { supabase });
  const retry = await applyAbilityOutcome({ studentId, conceptId, outcome: "correct", sourceEventId: event.id, difficulty: "easy" }, { supabase });
  assert.equal(first.alreadyProcessed, false);
  assert.equal(retry.alreadyProcessed, true);
  assert.equal(first.ability.theta, retry.ability.theta);
  assert.equal(fake.tables.abilityTransitions.rows.length, 1);
});

test("rejects an unknown source event, an unknown concept, and an invalid difficulty label", async () => {
  const { supabase, studentId, conceptId } = await setup();
  await assert.rejects(() => applyAbilityOutcome({ studentId, conceptId, outcome: "correct", sourceEventId: randomUUID(), difficulty: "medium" }, { supabase }), AbilityValidationError);

  const event = await recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED" }, { supabase });
  await assert.rejects(() => applyAbilityOutcome({ studentId, conceptId: randomUUID(), outcome: "correct", sourceEventId: event.id, difficulty: "medium" }, { supabase }), AbilityValidationError);
  await assert.rejects(() => applyAbilityOutcome({ studentId, conceptId, outcome: "correct", sourceEventId: event.id, difficulty: "extreme" as never }, { supabase }), AbilityValidationError);
});

// --- Step 13 / 31: one event, two independent consumers ---------------------------------------

test("one authoritative QUIZ_ANSWERED event updates BKT exactly once and IRT exactly once, neither blocking the other", async () => {
  const { supabase, fake, studentId, conceptId } = await setup();
  const { bkt, irt } = await recordScoredOutcomeWithAbility({ studentId, conceptId, outcome: "correct", difficulty: "hard" }, { supabase });

  assert.equal(bkt.alreadyProcessed, false);
  assert.equal(irt.alreadyProcessed, false);
  assert.equal(bkt.transition.sourceEventId, irt.transition.sourceEventId); // same underlying event
  assert.equal(fake.tables.transitions.rows.length, 1); // exactly one BKT transition
  assert.equal(fake.tables.abilityTransitions.rows.length, 1); // exactly one IRT transition
});

test("retrying the same composed event does not duplicate either BKT or IRT state", async () => {
  const { supabase, fake, studentId, conceptId } = await setup();
  const event = await recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED", metadata: { correct: true, difficulty: "medium" } }, { supabase });

  const { applyLearningOutcome } = await import("@/lib/learning/mastery");
  await applyLearningOutcome({ studentId, conceptId, outcome: "correct", sourceEventId: event.id }, { supabase });
  await applyAbilityOutcome({ studentId, conceptId, outcome: "correct", sourceEventId: event.id, difficulty: "medium" }, { supabase });

  const bktRetry = await applyLearningOutcome({ studentId, conceptId, outcome: "correct", sourceEventId: event.id }, { supabase });
  const irtRetry = await applyAbilityOutcome({ studentId, conceptId, outcome: "correct", sourceEventId: event.id, difficulty: "medium" }, { supabase });

  assert.equal(bktRetry.alreadyProcessed, true);
  assert.equal(irtRetry.alreadyProcessed, true);
  assert.equal(fake.tables.transitions.rows.length, 1);
  assert.equal(fake.tables.abilityTransitions.rows.length, 1);
  assert.equal(fake.tables.masteryStates.rows[0].evidence_count, 1);
  assert.equal(fake.tables.abilities.rows[0].observation_count, 1);
});

// --- Read helpers -------------------------------------------------------------------------------

test("listAbilities returns every subject the student has evidence on", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const { concept: mlConcept } = await createOrResolveConcept({ subject: "Machine Learning", displayName: "Linear Regression" }, { supabase });
  await recordScoredOutcomeWithAbility({ studentId, conceptId, outcome: "correct", difficulty: "medium" }, { supabase });
  await recordScoredOutcomeWithAbility({ studentId, conceptId: mlConcept.id, outcome: "incorrect", difficulty: "easy" }, { supabase });
  const abilities = await listAbilities(studentId, { supabase });
  assert.equal(abilities.length, 2);
});

test("hasSufficientAbilityEvidence gates on the shared MIN_EVIDENCE_FOR_ADAPTIVE floor (3)", async () => {
  const { supabase, studentId, conceptId, subject } = await setup();
  await recordScoredOutcomeWithAbility({ studentId, conceptId, outcome: "correct", difficulty: "medium" }, { supabase });
  let ability = await getAbility(studentId, subject, { supabase });
  assert.equal(hasSufficientAbilityEvidence(ability!), false);
  await recordScoredOutcomeWithAbility({ studentId, conceptId, outcome: "correct", difficulty: "medium" }, { supabase });
  await recordScoredOutcomeWithAbility({ studentId, conceptId, outcome: "correct", difficulty: "medium" }, { supabase });
  ability = await getAbility(studentId, subject, { supabase });
  assert.equal(hasSufficientAbilityEvidence(ability!), true);
});

// --- Replay (Step 25) --------------------------------------------------------------------------

test("deterministic replay from raw events reproduces the persisted theta exactly", async () => {
  const { supabase, studentId, conceptId, subject } = await setup();
  await recordScoredOutcomeWithAbility({ studentId, conceptId, outcome: "correct", difficulty: "hard" }, { supabase });
  await recordScoredOutcomeWithAbility({ studentId, conceptId, outcome: "incorrect", difficulty: "easy" }, { supabase });
  await recordScoredOutcomeWithAbility({ studentId, conceptId, outcome: "correct", difficulty: "medium" }, { supabase });

  const replay = await replayAbilityFromEvents(studentId, subject, { supabase });
  assert.equal(replay.matches, true);
  assert.ok(Math.abs(replay.replayedTheta - replay.persistedTheta!) < 1e-9);
});

test("replay with no evidence yet returns theta=0 and no persisted state to compare against", async () => {
  const { supabase, studentId, subject } = await setup();
  const replay = await replayAbilityFromEvents(studentId, subject, { supabase });
  assert.equal(replay.persistedTheta, null);
  assert.equal(replay.matches, false);
  assert.equal(replay.replayedTheta, 0);
});

test("replay scopes strictly to the given subject's concepts", async () => {
  const { supabase, studentId, conceptId, subject } = await setup();
  const { concept: mlConcept } = await createOrResolveConcept({ subject: "Machine Learning", displayName: "Linear Regression" }, { supabase });
  await recordScoredOutcomeWithAbility({ studentId, conceptId, outcome: "correct", difficulty: "medium" }, { supabase });
  await recordScoredOutcomeWithAbility({ studentId, conceptId: mlConcept.id, outcome: "incorrect", difficulty: "hard" }, { supabase });

  const algorithmsReplay = await replayAbilityFromEvents(studentId, subject, { supabase });
  assert.equal(algorithmsReplay.matches, true);
  const mlReplay = await replayAbilityFromEvents(studentId, "machine-learning", { supabase });
  assert.equal(mlReplay.matches, true);
  assert.notEqual(algorithmsReplay.persistedTheta, mlReplay.persistedTheta);
});

// --- Concurrency ---------------------------------------------------------------------------------

test("an IRT CAS conflict is retried and eventually succeeds with no lost update", async () => {
  const { supabase: baseSupabase, fake, studentId, conceptId } = await setup();
  const event = await recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED", metadata: { correct: true, difficulty: "medium" } }, { supabase: baseSupabase });

  let rpcCalls = 0;
  const racingSupabase = {
    ...fake,
    rpc: async (fn: string, params: Record<string, unknown>) => {
      if (fn === "apply_irt_transition") {
        rpcCalls += 1;
        if (rpcCalls === 1) {
          const now = new Date().toISOString();
          fake.tables.abilities.rows.push({
            student_id: studentId,
            subject: "algorithms",
            theta: 0.5,
            observation_count: 1,
            correct_count: 1,
            incorrect_count: 0,
            first_observed_at: now,
            last_observed_at: now,
            created_at: now,
            updated_at: now,
          });
        }
      }
      return fake.rpc(fn as never, params);
    },
  } as never;

  const result = await applyAbilityOutcome({ studentId, conceptId, outcome: "correct", sourceEventId: event.id, difficulty: "medium" }, { supabase: racingSupabase });
  assert.equal(rpcCalls, 2);
  assert.equal(result.alreadyProcessed, false);
  assert.equal(fake.tables.abilityTransitions.rows.length, 1);
  assert.equal(result.ability.observationCount, 2);
});
