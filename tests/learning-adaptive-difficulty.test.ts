import assert from "node:assert/strict";
import test from "node:test";
import { decideDifficulty } from "@/lib/pedagogy/difficulty";
import type { AdaptiveDifficultyInput } from "@/types/learning";

function input(overrides: Partial<AdaptiveDifficultyInput>): AdaptiveDifficultyInput {
  return { previousBand: "medium", pMastery: 0.5, bktEvidenceCount: 5, irtTheta: null, irtObservationCount: 0, pfaPlateaued: false, ...overrides };
}

test("fewer than 3 scored opportunities -> pinned to medium, INSUFFICIENT_EVIDENCE, never adapted", () => {
  const decision = decideDifficulty(input({ previousBand: "hard", pMastery: 0.99, bktEvidenceCount: 2 }));
  assert.equal(decision.recommendedDifficulty, "medium");
  assert.equal(decision.reasonCode, "INSUFFICIENT_EVIDENCE");
  assert.equal(decision.evidenceSufficient, false);
  assert.equal(decision.changed, true); // hard -> medium is a real, reported change
});

test("exactly at the evidence floor (3), the normal policy already applies", () => {
  const decision = decideDifficulty(input({ previousBand: "medium", pMastery: 0.5, bktEvidenceCount: 3 }));
  assert.equal(decision.evidenceSufficient, true);
  assert.equal(decision.recommendedDifficulty, "medium"); // mastery is in the dead zone -- no movement
  assert.equal(decision.reasonCode, "NO_CHANGE");
});

test("mastery inside the hysteresis dead zone produces NO_CHANGE", () => {
  const decision = decideDifficulty(input({ previousBand: "medium", pMastery: 0.5 }));
  assert.equal(decision.recommendedDifficulty, "medium");
  assert.equal(decision.changed, false);
  assert.equal(decision.reasonCode, "NO_CHANGE");
});

test("strong BKT mastery crossing the rise threshold increases the band (MASTERY_SUPPORTS_INCREASE)", () => {
  const decision = decideDifficulty(input({ previousBand: "medium", pMastery: 0.9, irtTheta: 1.5, irtObservationCount: 5 }));
  // theta=1.5 against hard's b=1.0 -> P(correct)=sigmoid(0.5)=0.622, inside [0.40,0.90] -- IRT does not override.
  assert.equal(decision.recommendedDifficulty, "hard");
  assert.equal(decision.reasonCode, "MASTERY_SUPPORTS_INCREASE");
  assert.equal(decision.changed, true);
});

test("weak BKT mastery never produces an inappropriate increase (no IRT signal present)", () => {
  const decision = decideDifficulty(input({ previousBand: "medium", pMastery: 0.3, irtObservationCount: 0 }));
  assert.notEqual(decision.recommendedDifficulty, "hard");
  assert.equal(decision.recommendedDifficulty, "easy");
  assert.equal(decision.reasonCode, "MASTERY_REQUIRES_SUPPORT");
});

test("weak IRT ability crossing the sanity floor decreases the band (ABILITY_BELOW_TARGET), even with BKT mastery in the dead zone", () => {
  const decision = decideDifficulty(input({ previousBand: "medium", pMastery: 0.5, irtTheta: -3, irtObservationCount: 5 }));
  // theta=-3 against medium's b=0 -> P(correct)=sigmoid(-3)~=0.047 < 0.40 -- IRT nudges down.
  assert.equal(decision.recommendedDifficulty, "easy");
  assert.equal(decision.reasonCode, "ABILITY_BELOW_TARGET");
});

test("strong IRT ability crossing the sanity ceiling increases the band (ABILITY_ABOVE_TARGET)", () => {
  const decision = decideDifficulty(input({ previousBand: "medium", pMastery: 0.5, irtTheta: 3, irtObservationCount: 5 }));
  // theta=3 against medium's b=0 -> P(correct)=sigmoid(3)~=0.953 > 0.90 -- IRT nudges up.
  assert.equal(decision.recommendedDifficulty, "hard");
  assert.equal(decision.reasonCode, "ABILITY_ABOVE_TARGET");
});

test("the IRT sanity modifier is ignored entirely below the evidence floor, even with an extreme theta", () => {
  const decision = decideDifficulty(input({ previousBand: "medium", pMastery: 0.5, irtTheta: -4, irtObservationCount: 2 }));
  assert.equal(decision.recommendedDifficulty, "medium");
  assert.equal(decision.reasonCode, "NO_CHANGE");
});

test("PFA plateau nudges the band down by one step, even with mastery in the dead zone", () => {
  const decision = decideDifficulty(input({ previousBand: "medium", pMastery: 0.5, pfaPlateaued: true }));
  assert.equal(decision.recommendedDifficulty, "easy");
  assert.equal(decision.reasonCode, "PFA_PLATEAU");
});

test("alternating mastery that stays within the hysteresis gap does not oscillate", () => {
  // 0.76 crosses the medium->hard RISE threshold (0.75); 0.66 is above the hard->medium FALL
  // threshold (0.65), so it must NOT fall back once risen -- a single shared threshold (e.g. 0.70)
  // would oscillate on this exact sequence; hysteresis must not.
  let band = decideDifficulty(input({ previousBand: "medium", pMastery: 0.76 })).recommendedDifficulty;
  assert.equal(band, "hard");
  band = decideDifficulty(input({ previousBand: band, pMastery: 0.66 })).recommendedDifficulty;
  assert.equal(band, "hard", "must not fall back -- 0.66 is inside the hysteresis gap, not below the fall threshold");
  band = decideDifficulty(input({ previousBand: band, pMastery: 0.76 })).recommendedDifficulty;
  assert.equal(band, "hard");
});

test("the anti-oscillation ceiling caps a 2-step move (BKT rise + IRT rise, same direction) to exactly 1 step", () => {
  // easy -> medium (BKT: 0.9 > 0.45) -> hard (IRT: theta=3 vs medium's b=0 gives P~=0.953 > 0.90) is
  // a 2-step net movement from "easy" -- the ceiling must cap it to "medium", not let it reach "hard".
  const decision = decideDifficulty(input({ previousBand: "easy", pMastery: 0.9, irtTheta: 3, irtObservationCount: 5 }));
  assert.equal(decision.recommendedDifficulty, "medium");
  assert.equal(decision.reasonCode, "HYSTERESIS_HOLD");
});

test("difficulty can never rise past 'hard', regardless of how strongly every signal pushes up", () => {
  const decision = decideDifficulty(input({ previousBand: "hard", pMastery: 0.99, irtTheta: 4, irtObservationCount: 20 }));
  assert.equal(decision.recommendedDifficulty, "hard");
  assert.equal(decision.changed, false);
});

test("difficulty can never fall past 'easy', regardless of how strongly every signal pushes down", () => {
  const decision = decideDifficulty(input({ previousBand: "easy", pMastery: 0.01, irtTheta: -4, irtObservationCount: 20, pfaPlateaued: true }));
  assert.equal(decision.recommendedDifficulty, "easy");
  assert.equal(decision.changed, false);
});

test("no history yet (previousBand null) defaults current difficulty to medium", () => {
  const decision = decideDifficulty(input({ previousBand: null, pMastery: 0.5 }));
  assert.equal(decision.currentDifficulty, "medium");
});

test("deterministic: identical input always produces identical output", () => {
  const a = decideDifficulty(input({ previousBand: "medium", pMastery: 0.8, irtTheta: 0.5, irtObservationCount: 5 }));
  const b = decideDifficulty(input({ previousBand: "medium", pMastery: 0.8, irtTheta: 0.5, irtObservationCount: 5 }));
  assert.deepEqual(a, b);
});

test("every reason code produced is one of the documented, deterministic set", () => {
  const allowed = new Set([
    "INSUFFICIENT_EVIDENCE",
    "MASTERY_SUPPORTS_INCREASE",
    "MASTERY_REQUIRES_SUPPORT",
    "PFA_PLATEAU",
    "ABILITY_ABOVE_TARGET",
    "ABILITY_BELOW_TARGET",
    "HYSTERESIS_HOLD",
    "NO_CHANGE",
  ]);
  const scenarios: AdaptiveDifficultyInput[] = [
    input({ bktEvidenceCount: 1 }),
    input({ pMastery: 0.9 }),
    input({ pMastery: 0.2 }),
    input({ pfaPlateaued: true }),
    input({ irtTheta: 3, irtObservationCount: 5 }),
    input({ irtTheta: -3, irtObservationCount: 5 }),
    input({ previousBand: "easy", pMastery: 0.9, irtTheta: 3, irtObservationCount: 5 }),
  ];
  for (const scenario of scenarios) assert.ok(allowed.has(decideDifficulty(scenario).reasonCode));
});
