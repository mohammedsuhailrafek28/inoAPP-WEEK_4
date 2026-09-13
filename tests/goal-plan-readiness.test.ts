import assert from "node:assert/strict";
import test from "node:test";
import { computeExamReadiness } from "@/lib/goal-plan/readiness";
import type { SubjectAnalytics } from "@/lib/learning/analytics";

function analytics(overrides: Partial<SubjectAnalytics> = {}): SubjectAnalytics {
  return {
    subject: "algorithms",
    conceptsAssessed: 0,
    stageCounts: { NEW: 0, LEARNING: 0, DEVELOPING: 0, PROFICIENT: 0, MASTERED: 0, REVIEW_DUE: 0 },
    reviewDueCount: 0,
    activeMisconceptionCount: 0,
    retentionHealth: { ok: 0, warning: 0, critical: 0 },
    transferCoverage: { readyCount: 0, masteredCount: 0 },
    autonomy: null,
    calibration: { studentId: "s1", sampleCount: 0, bias: null, actionable: false, state: "insufficient_evidence" },
    quizEvidence: { deterministic: { attempts: 0, correct: 0 }, llmGraded: { attempts: 0, correct: 0 } },
    recentSessionCount: 0,
    concepts: [],
    revisionRecommendations: [],
    transferPractice: [],
    ...overrides,
  };
}

test("readiness is the ratio of MASTERED+PROFICIENT concepts to total concepts, as a percentage", () => {
  const result = computeExamReadiness(
    analytics({
      stageCounts: { NEW: 0, LEARNING: 1, DEVELOPING: 1, PROFICIENT: 1, MASTERED: 1, REVIEW_DUE: 0 },
      concepts: Array(4).fill({}) as never,
    }),
  );
  assert.equal(result.readyConceptCount, 2); // PROFICIENT + MASTERED
  assert.equal(result.totalConceptCount, 4);
  assert.equal(result.readyPercent, 50);
});

test("REVIEW_DUE is never counted as ready, but is surfaced separately", () => {
  const result = computeExamReadiness(
    analytics({
      stageCounts: { NEW: 0, LEARNING: 0, DEVELOPING: 0, PROFICIENT: 0, MASTERED: 1, REVIEW_DUE: 2 },
      concepts: Array(3).fill({}) as never,
    }),
  );
  assert.equal(result.readyConceptCount, 1); // REVIEW_DUE excluded from the ratio
  assert.equal(result.reviewDueCount, 2); // but reported as its own field
  assert.equal(result.readyPercent, 33);
});

test("no score-soup: readiness never reads retention health, calibration, autonomy, transfer, or quiz evidence -- only stageCounts/concepts/activeMisconceptionCount", () => {
  const a = analytics({ stageCounts: { NEW: 0, LEARNING: 0, DEVELOPING: 0, PROFICIENT: 2, MASTERED: 0, REVIEW_DUE: 0 }, concepts: Array(2).fill({}) as never });
  const b = { ...a, retentionHealth: { ok: 99, warning: 99, critical: 99 }, autonomy: { studentId: "s", score: 0.01, components: {} as never, trend: "declining" as const, historicalScoreCount: 99 }, calibration: { ...a.calibration, bias: 0.9 } };
  assert.deepEqual(computeExamReadiness(a), computeExamReadiness(b));
});

test("zero registered concepts yields 0%, never a division-by-zero artifact", () => {
  const result = computeExamReadiness(analytics({ concepts: [] }));
  assert.equal(result.readyPercent, 0);
  assert.equal(result.totalConceptCount, 0);
});

test("category bands: LOW < 40%, DEVELOPING 40-74%, READY >= 75%", () => {
  assert.equal(computeExamReadiness(analytics({ stageCounts: { NEW: 3, LEARNING: 0, DEVELOPING: 0, PROFICIENT: 0, MASTERED: 0, REVIEW_DUE: 0 }, concepts: Array(3).fill({}) as never })).category, "LOW");
  assert.equal(computeExamReadiness(analytics({ stageCounts: { NEW: 0, LEARNING: 0, DEVELOPING: 0, PROFICIENT: 2, MASTERED: 0, REVIEW_DUE: 0 }, concepts: Array(4).fill({}) as never })).category, "DEVELOPING");
  assert.equal(computeExamReadiness(analytics({ stageCounts: { NEW: 0, LEARNING: 0, DEVELOPING: 0, PROFICIENT: 0, MASTERED: 4, REVIEW_DUE: 0 }, concepts: Array(4).fill({}) as never })).category, "READY");
});

test("activeMisconceptionCount passes through unchanged", () => {
  const result = computeExamReadiness(analytics({ activeMisconceptionCount: 3, concepts: Array(1).fill({}) as never }));
  assert.equal(result.activeMisconceptionCount, 3);
});
