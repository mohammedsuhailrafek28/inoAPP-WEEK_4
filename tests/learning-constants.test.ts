import assert from "node:assert/strict";
import test from "node:test";
import { LEARNING_CONFIG, MODEL_PARAMETERS, PRODUCT_POLICY_THRESHOLDS, SAFETY_CLAMPS, type ConstantProvenance } from "@/lib/learning/constants";

test("LEARNING_CONFIG is versioned and structured into the three locked categories", () => {
  assert.equal(LEARNING_CONFIG.version, 1);
  assert.equal(LEARNING_CONFIG.MODEL_PARAMETERS, MODEL_PARAMETERS);
  assert.equal(LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS, PRODUCT_POLICY_THRESHOLDS);
  assert.equal(LEARNING_CONFIG.SAFETY_CLAMPS, SAFETY_CLAMPS);
});

test("STALE_SESSION_MINUTES is locked at 90 with OUR_CHOICE provenance and a rationale", () => {
  const constant = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.STALE_SESSION_MINUTES;
  assert.equal(constant.value, 90);
  const provenance: ConstantProvenance = constant.provenance;
  assert.equal(provenance, "OUR_CHOICE");
  assert.ok(constant.rationale.length > 0);
});

test("every provenance tag present is one of the three locked categories", () => {
  const allowed = new Set<ConstantProvenance>(["PUBLISHED_ALGORITHM", "TUTOR_MCP_CHOICE", "OUR_CHOICE"]);
  for (const bucket of [MODEL_PARAMETERS, PRODUCT_POLICY_THRESHOLDS, SAFETY_CLAMPS]) {
    for (const constant of Object.values(bucket)) {
      assert.ok(allowed.has((constant as { provenance: ConstantProvenance }).provenance));
    }
  }
});

test("LEARNING_CONFIG and its category objects are frozen -- no runtime mutation, no client tuning surface", () => {
  assert.ok(Object.isFrozen(LEARNING_CONFIG));
  assert.ok(Object.isFrozen(LEARNING_CONFIG.MODEL_PARAMETERS));
  assert.ok(Object.isFrozen(LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS));
  assert.ok(Object.isFrozen(LEARNING_CONFIG.SAFETY_CLAMPS));
  assert.ok(Object.isFrozen(LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.STALE_SESSION_MINUTES));

  // ES modules are strict-mode by default, so mutating a frozen object throws rather than
  // silently failing -- exactly the "no scattered magic numbers, no runtime mutation" guarantee.
  assert.throws(() => {
    (LEARNING_CONFIG as unknown as { version: number }).version = 2;
  }, TypeError);
});
