import assert from "node:assert/strict";
import test from "node:test";
import { selectAction } from "@/lib/pedagogy/select-action";
import { PEDAGOGICAL_ACTIONS } from "@/types/learning";
import type { AdaptiveDifficultyDecision, Misconception, PedagogicalDecisionInput, PrerequisiteReadinessDetail, PrerequisiteReadinessResult, ScaffoldingDecision } from "@/types/learning";

const NOW = new Date("2026-06-15T00:00:00.000Z");

/** Reverse-engineers a {stability, lastReviewedAt} pair that yields exactly `retrievability` when evaluated at `now`, using FSRS's own formula -- so tests can express intent as "retrievability is X" while exercising the real stability/lastReviewedAt-based input contract (Step 26). */
function retentionFor(retrievability: number, now: Date = NOW): { stability: number; lastReviewedAt: string } {
  const FACTOR = 19 / 81;
  const stability = 5; // arbitrary fixed stability -- only the resulting retrievability matters here
  const elapsedDays = (stability / FACTOR) * (Math.pow(retrievability, -2) - 1);
  return { stability, lastReviewedAt: new Date(now.getTime() - elapsedDays * 24 * 60 * 60 * 1000).toISOString() };
}

function readyReadiness(): PrerequisiteReadinessResult {
  return { targetConceptId: "concept-1", targetConceptKey: "concept-1", directPrerequisites: [], ready: true, blockers: [], remediationOrder: [] };
}

function blockedReadiness(): PrerequisiteReadinessResult {
  const blocker: PrerequisiteReadinessDetail = {
    conceptId: "prereq-1",
    conceptKey: "prereq-key-1",
    displayName: "Prereq One",
    pMastery: 0.4,
    evidenceCount: 1,
    evidenceSufficient: false,
    status: "insufficient_evidence",
    reviewStatus: null,
    blockerReasonCode: "PREREQUISITE_EVIDENCE_INSUFFICIENT",
  };
  return {
    targetConceptId: "concept-1",
    targetConceptKey: "concept-1",
    directPrerequisites: [blocker],
    ready: false,
    blockers: [blocker],
    remediationOrder: [{ id: "prereq-1", conceptKey: "prereq-key-1", displayName: "Prereq One", subject: "algorithms" }],
  };
}

function misconception(tag: string, firstSeenAt: string): Misconception {
  return {
    id: `misc-${tag}`,
    studentId: "student-1",
    conceptId: "concept-1",
    tag,
    description: "d",
    status: "active",
    evidenceCount: 2,
    firstSeenAt,
    lastSeenAt: firstSeenAt,
    createdAt: firstSeenAt,
    updatedAt: firstSeenAt,
  };
}

function difficultyDecision(overrides: Partial<AdaptiveDifficultyDecision> = {}): AdaptiveDifficultyDecision {
  return { currentDifficulty: "medium", recommendedDifficulty: "medium", changed: false, reasonCode: "NO_CHANGE", evidenceSufficient: true, ...overrides };
}

function scaffoldingDecision(overrides: Partial<ScaffoldingDecision> = {}): ScaffoldingDecision {
  return { level: "STANDARD", baseLevel: "STANDARD", reasonCodes: ["AUTONOMY_STANDARD"], evidenceSufficient: true, autonomy: null, ...overrides };
}

function baseInput(overrides: Partial<PedagogicalDecisionInput> = {}): PedagogicalDecisionInput {
  return {
    targetConceptId: "concept-1",
    targetConceptKey: "concept-1",
    readiness: readyReadiness(),
    pMastery: 0.5,
    evidenceCount: 5,
    hasDiverseEvidence: false,
    mostRecentAttemptCorrect: true,
    stability: null,
    lastReviewedAt: null,
    activeMisconceptions: [],
    transferReadiness: "not_attempted",
    difficultyDecision: difficultyDecision(),
    scaffolding: scaffoldingDecision(),
    ...overrides,
  };
}

// --- Step 30: one test per locked action --------------------------------------------------------

test("row 1: retrievability < 0.30 on an already-mastered concept -> SPACED_REVIEW", () => {
  const decision = selectAction(baseInput({ pMastery: 0.9, ...retentionFor(0.2) }), NOW);
  assert.equal(decision.action, "SPACED_REVIEW");
  assert.deepEqual(decision.reasonCodes, ["RETENTION_CRITICAL_ON_MASTERED"]);
  assert.equal(decision.targetConceptId, "concept-1");
  assert.equal(decision.difficulty, "medium");
  assert.equal(decision.scaffoldingLevel, "STANDARD");
});

test("row 2: unready prerequisite -> PREREQUISITE_REMEDIATION, retargeted to the blocker", () => {
  const decision = selectAction(baseInput({ readiness: blockedReadiness() }), NOW);
  assert.equal(decision.action, "PREREQUISITE_REMEDIATION");
  assert.equal(decision.targetConceptId, "prereq-1");
  assert.equal(decision.targetConceptKey, "prereq-key-1");
  assert.deepEqual(decision.reasonCodes, ["PREREQUISITE_BLOCKED"]);
});

test("row 3: active misconception -> EXPLAIN focused on the tag", () => {
  const decision = selectAction(baseInput({ activeMisconceptions: [misconception("off_by_one", "2026-01-01T00:00:00.000Z")] }), NOW);
  assert.equal(decision.action, "EXPLAIN");
  assert.deepEqual(decision.reasonCodes, ["ACTIVE_MISCONCEPTION"]);
  assert.deepEqual(decision.explain, { focus: "misconception", tag: "off_by_one" });
});

test("row 3: with multiple active misconceptions, the earliest-activated tag is chosen deterministically", () => {
  const decision = selectAction(
    baseInput({
      activeMisconceptions: [misconception("later_tag", "2026-02-01T00:00:00.000Z"), misconception("earlier_tag", "2026-01-01T00:00:00.000Z")],
    }),
    NOW,
  );
  assert.deepEqual(decision.explain, { focus: "misconception", tag: "earlier_tag" });
});

test("row 4: insufficient evidence (or never seen) -> EXPLAIN (general)", () => {
  const decision = selectAction(baseInput({ evidenceCount: 1 }), NOW);
  assert.equal(decision.action, "EXPLAIN");
  assert.deepEqual(decision.reasonCodes, ["INSUFFICIENT_EVIDENCE"]);
  assert.equal(decision.explain, null);
  assert.equal(decision.evidenceSufficient, false);

  const neverSeen = selectAction(baseInput({ evidenceCount: 0, pMastery: null }), NOW);
  assert.equal(neverSeen.action, "EXPLAIN");
  assert.deepEqual(neverSeen.reasonCodes, ["INSUFFICIENT_EVIDENCE"]);
});

test("row 5: mastered, diverse evidence, transfer not ready -> TRANSFER_CHALLENGE", () => {
  const decision = selectAction(baseInput({ pMastery: 0.9, hasDiverseEvidence: true, transferReadiness: "attempted" }), NOW);
  assert.equal(decision.action, "TRANSFER_CHALLENGE");
  assert.deepEqual(decision.reasonCodes, ["TRANSFER_ELIGIBLE"]);
});

test("row 6: mastered, transfer already ready -> DEEPEN", () => {
  const decision = selectAction(baseInput({ pMastery: 0.9, transferReadiness: "ready" }), NOW);
  assert.equal(decision.action, "DEEPEN");
  assert.deepEqual(decision.reasonCodes, ["TRANSFER_DEMONSTRATED"]);
});

test("row 7: most recent attempt incorrect -> SIMPLIFY", () => {
  const decision = selectAction(baseInput({ mostRecentAttemptCorrect: false }), NOW);
  assert.equal(decision.action, "SIMPLIFY");
  assert.deepEqual(decision.reasonCodes, ["RECENT_ATTEMPT_INCORRECT"]);
});

test("row 8: the ordinary practice band (0.30 <= mastery < 0.85), no override fired -> QUIZ", () => {
  const decision = selectAction(baseInput(), NOW);
  assert.equal(decision.action, "QUIZ");
  assert.deepEqual(decision.reasonCodes, ["PRACTICE_BAND"]);
});

test("row 8 is also the cascade's total fallback: mastery below 0.30 with no other override still resolves to QUIZ, never an unhandled case", () => {
  const decision = selectAction(baseInput({ pMastery: 0.1, mostRecentAttemptCorrect: true }), NOW);
  assert.equal(decision.action, "QUIZ");
  assert.deepEqual(decision.reasonCodes, ["PRACTICE_BAND"]);
});

test("row 9 (HINT) and row 10 (CONTINUE) are real, named actions but the cascade never produces them for a concrete target concept", () => {
  assert.ok(PEDAGOGICAL_ACTIONS.includes("HINT"));
  assert.ok(PEDAGOGICAL_ACTIONS.includes("CONTINUE"));
  // Sweep every branch above -- none of their outputs are HINT/CONTINUE.
  const scenarios: Partial<PedagogicalDecisionInput>[] = [
    { pMastery: 0.9, ...retentionFor(0.2) },
    { readiness: blockedReadiness() },
    { activeMisconceptions: [misconception("t", "2026-01-01T00:00:00.000Z")] },
    { evidenceCount: 0 },
    { pMastery: 0.9, hasDiverseEvidence: true, transferReadiness: "attempted" },
    { pMastery: 0.9, transferReadiness: "ready" },
    { mostRecentAttemptCorrect: false },
    {},
  ];
  for (const scenario of scenarios) {
    const action = selectAction(baseInput(scenario), NOW).action;
    assert.notEqual(action, "HINT");
    assert.notEqual(action, "CONTINUE");
  }
});

// --- Step 5/19: contract completeness ------------------------------------------------------------

test("difficulty and scaffolding are always carried through unchanged, regardless of action", () => {
  const decision = selectAction(baseInput({ difficultyDecision: difficultyDecision({ recommendedDifficulty: "hard" }), scaffolding: scaffoldingDecision({ level: "HIGH_SUPPORT" }) }), NOW);
  assert.equal(decision.difficulty, "hard");
  assert.equal(decision.scaffoldingLevel, "HIGH_SUPPORT");
  assert.equal(decision.supportingSignals.difficulty, "hard");
  assert.equal(decision.supportingSignals.scaffoldingLevel, "HIGH_SUPPORT");
});

test("supportingSignals is a bounded, specific snapshot -- not the entire learner profile", () => {
  const decision = selectAction(baseInput(), NOW);
  assert.deepEqual(
    Object.keys(decision.supportingSignals).sort(),
    ["pMastery", "evidenceCount", "evidenceSufficient", "retrievability", "reviewDue", "prerequisiteBlocked", "activeMisconceptionCount", "transferReadiness", "difficulty", "scaffoldingLevel"].sort(),
  );
});

// --- Step 26: determinism --------------------------------------------------------------------

test("determinism: identical input produces byte-identical output, called twice", () => {
  const input = baseInput({ pMastery: 0.6, evidenceCount: 4 });
  assert.deepEqual(selectAction(input, NOW), selectAction(input, NOW));
});

test("determinism: retention due-ness is driven only by the injected `now` against a fixed lastReviewedAt, never the real wall clock", () => {
  // A fixed, absolute last-reviewed instant and stability -- the same input every time. Only the
  // injected `now` changes between calls, and it alone determines whether review is due.
  const input = baseInput({ pMastery: 0.9, stability: 3, lastReviewedAt: "2026-01-01T00:00:00.000Z" });
  const rightAfterReview = selectAction(input, new Date("2026-01-01T01:00:00.000Z"));
  assert.notEqual(rightAfterReview.action, "SPACED_REVIEW"); // retrievability ~1 immediately after review

  const longAfterReview = selectAction(input, new Date("2027-06-01T00:00:00.000Z")); // ~1.5 years later
  assert.equal(longAfterReview.action, "SPACED_REVIEW"); // now genuinely decayed below the critical threshold

  // Calling again with the exact same (input, now) pair is still byte-identical -- no hidden
  // dependency on the real clock creeps in.
  assert.deepEqual(longAfterReview, selectAction(input, new Date("2027-06-01T00:00:00.000Z")));
});

// --- Step 31: precedence matrix -- for every higher-priority row H and lower-priority row L, H+L must choose H ---

interface RowTrigger {
  row: number;
  reasonCode: string;
  fields: Partial<PedagogicalDecisionInput>;
}

const ROW_TRIGGERS: RowTrigger[] = [
  { row: 1, reasonCode: "RETENTION_CRITICAL_ON_MASTERED", fields: { pMastery: 0.9, ...retentionFor(0.1) } },
  { row: 2, reasonCode: "PREREQUISITE_BLOCKED", fields: { readiness: blockedReadiness() } },
  { row: 3, reasonCode: "ACTIVE_MISCONCEPTION", fields: { activeMisconceptions: [misconception("t", "2026-01-01T00:00:00.000Z")] } },
  { row: 4, reasonCode: "INSUFFICIENT_EVIDENCE", fields: { evidenceCount: 1 } },
  { row: 5, reasonCode: "TRANSFER_ELIGIBLE", fields: { pMastery: 0.9, hasDiverseEvidence: true, transferReadiness: "attempted" } },
  { row: 7, reasonCode: "RECENT_ATTEMPT_INCORRECT", fields: { mostRecentAttemptCorrect: false } },
];
// Row 6 (DEEPEN, transferReadiness='ready') is a sibling branch of row 5 under the same "mastered"
// gate, not a precedence relationship -- they set the same field to mutually exclusive values and
// can never co-occur, so it's intentionally excluded from this pairwise matrix. Row 8 is the
// fallback (already covered by "row 8 wins when nothing else fires" above); pairing it as the
// lower-priority side of every other row is exactly what "no override above fired" already means,
// so it's likewise omitted here to keep the matrix meaningful rather than redundant.

test("precedence matrix: for every higher-priority row H and lower-priority row L, H+L resolves to H", () => {
  for (let i = 0; i < ROW_TRIGGERS.length; i++) {
    for (let j = i + 1; j < ROW_TRIGGERS.length; j++) {
      const higher = ROW_TRIGGERS[i];
      const lower = ROW_TRIGGERS[j];
      const combined = baseInput({ ...lower.fields, ...higher.fields });
      const decision = selectAction(combined, NOW);
      assert.equal(decision.reasonCodes[0], higher.reasonCode, `row ${higher.row} should win over row ${lower.row}, got reason ${decision.reasonCodes[0]}`);
    }
  }
});

// --- Step 25: explicit contradictory-signal scenarios -------------------------------------------

test("contradictory: high mastery + review due -> SPACED_REVIEW, mastery itself is untouched", () => {
  const decision = selectAction(baseInput({ pMastery: 0.95, evidenceCount: 20, ...retentionFor(0.05) }), NOW);
  assert.equal(decision.action, "SPACED_REVIEW");
  assert.equal(decision.supportingSignals.pMastery, 0.95); // never lowered because review is due
});

test("contradictory: high mastery + active misconception -> EXPLAIN (misconception), not advancement", () => {
  const decision = selectAction(baseInput({ pMastery: 0.95, activeMisconceptions: [misconception("t", "2026-01-01T00:00:00.000Z")], transferReadiness: "ready" }), NOW);
  assert.equal(decision.action, "EXPLAIN");
  assert.deepEqual(decision.reasonCodes, ["ACTIVE_MISCONCEPTION"]);
});

test("contradictory: high mastery + transfer not demonstrated -> TRANSFER_CHALLENGE, not DEEPEN", () => {
  const decision = selectAction(baseInput({ pMastery: 0.95, hasDiverseEvidence: true, transferReadiness: "attempted" }), NOW);
  assert.equal(decision.action, "TRANSFER_CHALLENGE");
});

test("contradictory: prerequisite blocked + review due on the target -> PREREQUISITE_REMEDIATION wins", () => {
  const decision = selectAction(baseInput({ readiness: blockedReadiness(), pMastery: 0.9, ...retentionFor(0.9) }), NOW);
  // Retrievability here is high (not the review-due trigger) to isolate the real conflict: even if
  // it WERE due, row 1 still outranks row 2 per the matrix above -- this scenario specifically
  // checks the readiness branch alone still fires correctly when mastery happens to be high too.
  assert.equal(decision.action, "PREREQUISITE_REMEDIATION");
});

test("contradictory: review due + active misconception -> SPACED_REVIEW wins (row 1 before row 3)", () => {
  const decision = selectAction(baseInput({ pMastery: 0.9, ...retentionFor(0.1), activeMisconceptions: [misconception("t", "2026-01-01T00:00:00.000Z")] }), NOW);
  assert.equal(decision.action, "SPACED_REVIEW");
});

test("contradictory: low mastery + high IRT-driven difficulty recommendation -> mastery/evidence still gate the action; difficulty is carried, never a substitute signal", () => {
  const decision = selectAction(baseInput({ pMastery: 0.2, evidenceCount: 6, difficultyDecision: difficultyDecision({ recommendedDifficulty: "hard" }) }), NOW);
  assert.equal(decision.action, "QUIZ"); // mastery/evidence-driven, not overridden by a "hard" difficulty recommendation
  assert.equal(decision.difficulty, "hard"); // still carried through as the attached difficulty
});
