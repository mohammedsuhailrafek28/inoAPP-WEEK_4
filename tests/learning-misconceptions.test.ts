import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  MisconceptionValidationError,
  listMisconceptions,
  normalizeMisconceptionTag,
  recordMisconceptionEvidence,
  reevaluateMisconceptionResolution,
} from "@/lib/learning/misconceptions";
import { recordLearningEvent } from "@/lib/learning/events";
import { createOrResolveConcept } from "@/lib/learning/concepts";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { createFakeLearningSupabase } from "./support/fake-learning-db";

async function setup() {
  const fake = createFakeLearningSupabase();
  const supabase = fake as never;
  const profile = await getOrCreateDefaultProfile({ supabase });
  const { concept } = await createOrResolveConcept({ subject: "Data Structures", displayName: "Binary Search" }, { supabase });
  return { supabase, fake, studentId: profile.id, conceptId: concept.id };
}

/** A plain scored attempt -- no misconception evidence proposed (the "interaction" the resolution window counts). */
async function incorrectEvent(studentId: string, conceptId: string, supabase: unknown) {
  return recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED", metadata: { correct: false } }, { supabase } as never);
}
async function correctEvent(studentId: string, conceptId: string, supabase: unknown) {
  return recordLearningEvent({ studentId, conceptId, eventType: "QUIZ_ANSWERED", metadata: { correct: true } }, { supabase } as never);
}

/**
 * The real evidence shape (§25, Phase 7 retrofit): an incorrect QUIZ_ANSWERED event, plus a
 * separate MISCONCEPTION_OBSERVED event proposing a tag about it (`relatedEventId` links them).
 * Returns the MISCONCEPTION_OBSERVED event -- the one recordMisconceptionEvidence() consumes.
 */
async function misconceptionObservedEvent(studentId: string, conceptId: string, supabase: unknown) {
  const quizEvent = await incorrectEvent(studentId, conceptId, supabase);
  return recordLearningEvent(
    { studentId, conceptId, eventType: "MISCONCEPTION_OBSERVED", metadata: { proposedByLlm: true, relatedEventId: quizEvent.id } },
    { supabase } as never,
  );
}

test("normalizeMisconceptionTag is deterministic and underscore-separated (§11's own example)", () => {
  assert.equal(normalizeMisconceptionTag("Off-by-one Boundary!"), "off_by_one_boundary");
  assert.equal(normalizeMisconceptionTag("off_by_one_boundary"), "off_by_one_boundary");
});

test("one wrong answer alone does not automatically create an active misconception -- it creates a candidate", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const event = await misconceptionObservedEvent(studentId, conceptId, supabase);
  const result = await recordMisconceptionEvidence({ studentId, conceptId, tag: "wrong_half_update", description: "Updates the wrong half of the search range.", sourceEventId: event.id }, { supabase });
  assert.equal(result.misconception.status, "candidate");
  assert.equal(result.misconception.evidenceCount, 1);
  assert.equal(result.alreadyProcessed, false);
});

test("a correct answer can never propose misconception evidence, even via a MISCONCEPTION_OBSERVED event", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const correctQuizEvent = await correctEvent(studentId, conceptId, supabase);
  const observed = await recordLearningEvent(
    { studentId, conceptId, eventType: "MISCONCEPTION_OBSERVED", metadata: { proposedByLlm: true, relatedEventId: correctQuizEvent.id } },
    { supabase },
  );
  await assert.rejects(
    () => recordMisconceptionEvidence({ studentId, conceptId, tag: "wrong_half_update", description: "x", sourceEventId: observed.id }, { supabase }),
    MisconceptionValidationError,
  );
});

test("candidate -> active requires MISCONCEPTION_ACTIVATION_EVIDENCE_COUNT (2) independent pieces of evidence for the same tag", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const first = await misconceptionObservedEvent(studentId, conceptId, supabase);
  const firstResult = await recordMisconceptionEvidence({ studentId, conceptId, tag: "wrong_half_update", description: "d", sourceEventId: first.id }, { supabase });
  assert.equal(firstResult.misconception.status, "candidate");

  const second = await misconceptionObservedEvent(studentId, conceptId, supabase);
  const secondResult = await recordMisconceptionEvidence({ studentId, conceptId, tag: "wrong_half_update", description: "d", sourceEventId: second.id }, { supabase });
  assert.equal(secondResult.misconception.status, "active");
  assert.equal(secondResult.misconception.evidenceCount, 2);
});

test("duplicate evidence (same source event) is idempotent -- retrying does not double-increment evidence_count", async () => {
  const { supabase, fake, studentId, conceptId } = await setup();
  const event = await misconceptionObservedEvent(studentId, conceptId, supabase);
  const first = await recordMisconceptionEvidence({ studentId, conceptId, tag: "wrong_half_update", description: "d", sourceEventId: event.id }, { supabase });
  const retry = await recordMisconceptionEvidence({ studentId, conceptId, tag: "wrong_half_update", description: "d", sourceEventId: event.id }, { supabase });
  assert.equal(first.alreadyProcessed, false);
  assert.equal(retry.alreadyProcessed, true);
  assert.equal(retry.misconception.evidenceCount, 1);
  assert.equal(fake.tables.misconceptionEvidence.rows.length, 1);
});

test("unrelated incorrect evidence (a different tag) does not count toward this tag's activation", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const first = await misconceptionObservedEvent(studentId, conceptId, supabase);
  await recordMisconceptionEvidence({ studentId, conceptId, tag: "wrong_half_update", description: "d", sourceEventId: first.id }, { supabase });

  const second = await misconceptionObservedEvent(studentId, conceptId, supabase);
  const unrelated = await recordMisconceptionEvidence({ studentId, conceptId, tag: "off_by_one_boundary", description: "d2", sourceEventId: second.id }, { supabase });
  assert.equal(unrelated.misconception.status, "candidate");
  assert.equal(unrelated.misconception.evidenceCount, 1);

  const wrongHalf = (await listMisconceptions(studentId, { conceptId }, { supabase })).find((m) => m.tag === "wrong_half_update")!;
  assert.equal(wrongHalf.status, "candidate");
  assert.equal(wrongHalf.evidenceCount, 1);
});

test("resolution requires positive contradicting evidence -- does not resolve merely because time passed with zero counter-evidence", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const e1 = await misconceptionObservedEvent(studentId, conceptId, supabase);
  await recordMisconceptionEvidence({ studentId, conceptId, tag: "wrong_half_update", description: "d", sourceEventId: e1.id }, { supabase });
  const e2 = await misconceptionObservedEvent(studentId, conceptId, supabase);
  await recordMisconceptionEvidence({ studentId, conceptId, tag: "wrong_half_update", description: "d", sourceEventId: e2.id }, { supabase }); // -> active

  // No further interactions at all yet.
  const result = await reevaluateMisconceptionResolution(studentId, conceptId, "wrong_half_update", { supabase });
  assert.equal(result!.status, "active");
});

test("ACTIVE -> RESOLVED once the last MISCONCEPTION_RESOLUTION_WINDOW (3) interactions since activation never re-trigger the tag", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const e1 = await misconceptionObservedEvent(studentId, conceptId, supabase);
  await recordMisconceptionEvidence({ studentId, conceptId, tag: "wrong_half_update", description: "d", sourceEventId: e1.id }, { supabase });
  const e2 = await misconceptionObservedEvent(studentId, conceptId, supabase);
  const activated = await recordMisconceptionEvidence({ studentId, conceptId, tag: "wrong_half_update", description: "d", sourceEventId: e2.id }, { supabase });
  assert.equal(activated.misconception.status, "active");

  // 3 subsequent interactions, all correct (none re-trigger the tag).
  await correctEvent(studentId, conceptId, supabase);
  await correctEvent(studentId, conceptId, supabase);
  await correctEvent(studentId, conceptId, supabase);

  const resolved = await reevaluateMisconceptionResolution(studentId, conceptId, "wrong_half_update", { supabase });
  assert.equal(resolved!.status, "resolved");
});

test("resolution does not fire early -- fewer than the resolution window's worth of post-activation interactions leaves it active", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const e1 = await misconceptionObservedEvent(studentId, conceptId, supabase);
  await recordMisconceptionEvidence({ studentId, conceptId, tag: "wrong_half_update", description: "d", sourceEventId: e1.id }, { supabase });
  const e2 = await misconceptionObservedEvent(studentId, conceptId, supabase);
  await recordMisconceptionEvidence({ studentId, conceptId, tag: "wrong_half_update", description: "d", sourceEventId: e2.id }, { supabase });

  await correctEvent(studentId, conceptId, supabase);
  await correctEvent(studentId, conceptId, supabase); // only 2, window is 3

  const result = await reevaluateMisconceptionResolution(studentId, conceptId, "wrong_half_update", { supabase });
  assert.equal(result!.status, "active");
});

test("a re-trigger within the resolution window prevents resolution", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const e1 = await misconceptionObservedEvent(studentId, conceptId, supabase);
  await recordMisconceptionEvidence({ studentId, conceptId, tag: "wrong_half_update", description: "d", sourceEventId: e1.id }, { supabase });
  const e2 = await misconceptionObservedEvent(studentId, conceptId, supabase);
  await recordMisconceptionEvidence({ studentId, conceptId, tag: "wrong_half_update", description: "d", sourceEventId: e2.id }, { supabase }); // -> active

  await correctEvent(studentId, conceptId, supabase);
  const reTrigger = await misconceptionObservedEvent(studentId, conceptId, supabase);
  await recordMisconceptionEvidence({ studentId, conceptId, tag: "wrong_half_update", description: "d", sourceEventId: reTrigger.id }, { supabase });
  await correctEvent(studentId, conceptId, supabase);
  await correctEvent(studentId, conceptId, supabase);

  const result = await reevaluateMisconceptionResolution(studentId, conceptId, "wrong_half_update", { supabase });
  assert.equal(result!.status, "active");
});

test("invalid backwards transition: a candidate cannot be resolved directly (only active -> resolved is a real transition)", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const e1 = await misconceptionObservedEvent(studentId, conceptId, supabase);
  await recordMisconceptionEvidence({ studentId, conceptId, tag: "wrong_half_update", description: "d", sourceEventId: e1.id }, { supabase });

  await correctEvent(studentId, conceptId, supabase);
  await correctEvent(studentId, conceptId, supabase);
  await correctEvent(studentId, conceptId, supabase);

  const result = await reevaluateMisconceptionResolution(studentId, conceptId, "wrong_half_update", { supabase });
  assert.equal(result!.status, "candidate"); // untouched -- reevaluateResolution only ever acts on 'active'
});

test("history is preserved -- a resolved misconception's row and evidence remain readable, never deleted", async () => {
  const { supabase, fake, studentId, conceptId } = await setup();
  const e1 = await misconceptionObservedEvent(studentId, conceptId, supabase);
  await recordMisconceptionEvidence({ studentId, conceptId, tag: "wrong_half_update", description: "d", sourceEventId: e1.id }, { supabase });
  const e2 = await misconceptionObservedEvent(studentId, conceptId, supabase);
  await recordMisconceptionEvidence({ studentId, conceptId, tag: "wrong_half_update", description: "d", sourceEventId: e2.id }, { supabase });
  await correctEvent(studentId, conceptId, supabase);
  await correctEvent(studentId, conceptId, supabase);
  await correctEvent(studentId, conceptId, supabase);
  await reevaluateMisconceptionResolution(studentId, conceptId, "wrong_half_update", { supabase });

  const all = await listMisconceptions(studentId, {}, { supabase });
  assert.equal(all.length, 1);
  assert.equal(all[0].status, "resolved");
  assert.equal(fake.tables.misconceptionEvidence.rows.length, 2); // both evidence rows still present
});

test("a resolved misconception that recurs reopens to 'active', evidence_count keeps accumulating (not a fresh candidate)", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const e1 = await misconceptionObservedEvent(studentId, conceptId, supabase);
  await recordMisconceptionEvidence({ studentId, conceptId, tag: "wrong_half_update", description: "d", sourceEventId: e1.id }, { supabase });
  const e2 = await misconceptionObservedEvent(studentId, conceptId, supabase);
  await recordMisconceptionEvidence({ studentId, conceptId, tag: "wrong_half_update", description: "d", sourceEventId: e2.id }, { supabase });
  await correctEvent(studentId, conceptId, supabase);
  await correctEvent(studentId, conceptId, supabase);
  await correctEvent(studentId, conceptId, supabase);
  const resolved = await reevaluateMisconceptionResolution(studentId, conceptId, "wrong_half_update", { supabase });
  assert.equal(resolved!.status, "resolved");

  const recurrence = await misconceptionObservedEvent(studentId, conceptId, supabase);
  const reopened = await recordMisconceptionEvidence({ studentId, conceptId, tag: "wrong_half_update", description: "d", sourceEventId: recurrence.id }, { supabase });
  assert.equal(reopened.misconception.status, "active");
  assert.equal(reopened.misconception.evidenceCount, 3);
});

test("client cannot directly set status/evidence_count -- recordEvidence's evidence contract has no such fields", async () => {
  const { supabase, studentId, conceptId } = await setup();
  const event = await misconceptionObservedEvent(studentId, conceptId, supabase);
  // The public evidence contract (MisconceptionEvidenceInput) is {studentId, conceptId, tag,
  // description, sourceEventId} -- structurally, there is no channel to pass a status or count.
  const result = await recordMisconceptionEvidence({ studentId, conceptId, tag: "wrong_half_update", description: "d", sourceEventId: event.id } as never, { supabase });
  assert.equal(result.misconception.status, "candidate");
  assert.equal(result.misconception.evidenceCount, 1);
});

test("rejects an unknown source event, a wrong event type, and a MISCONCEPTION_OBSERVED event missing/pointing to an invalid related event", async () => {
  const { supabase, studentId, conceptId } = await setup();
  await assert.rejects(
    () => recordMisconceptionEvidence({ studentId, conceptId, tag: "x", description: "d", sourceEventId: randomUUID() }, { supabase }),
    MisconceptionValidationError,
  );

  const wrongEventType = await recordLearningEvent({ studentId, conceptId, eventType: "QUESTION_ASKED" }, { supabase });
  await assert.rejects(() => recordMisconceptionEvidence({ studentId, conceptId, tag: "x", description: "d", sourceEventId: wrongEventType.id }, { supabase }), MisconceptionValidationError);

  const missingRelated = await recordLearningEvent({ studentId, conceptId, eventType: "MISCONCEPTION_OBSERVED", metadata: { proposedByLlm: true } }, { supabase });
  await assert.rejects(() => recordMisconceptionEvidence({ studentId, conceptId, tag: "x", description: "d", sourceEventId: missingRelated.id }, { supabase }), MisconceptionValidationError);

  const notProposedByLlm = await recordLearningEvent({ studentId, conceptId, eventType: "MISCONCEPTION_OBSERVED", metadata: { relatedEventId: randomUUID() } }, { supabase });
  await assert.rejects(() => recordMisconceptionEvidence({ studentId, conceptId, tag: "x", description: "d", sourceEventId: notProposedByLlm.id }, { supabase }), MisconceptionValidationError);
});
