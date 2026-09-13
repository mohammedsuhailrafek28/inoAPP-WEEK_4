import assert from "node:assert/strict";
import test from "node:test";
import { ACTION_LABEL, AGENT_ACTIVITY_KIND_LABEL, CALIBRATION_LABEL, DIFFICULTY_LABEL, PEDAGOGICAL_REASON_LABEL, PLAN_ACTIVITY_CTA_LABEL, PLAN_ACTIVITY_TYPE_LABEL, REVISION_REASON_LABEL, SCAFFOLDING_LABEL, STAGE_GLYPH, STAGE_LABEL, TEACH_BACK_UNDERSTANDING_LABEL, TRANSFER_LABEL, revisionIntentLabel } from "@/lib/ui/labels";
import { MASTERY_STAGES } from "@/lib/learning/olm";
import { PEDAGOGICAL_ACTIONS } from "@/types/learning";
import { PEDAGOGICAL_REASON_CODES } from "@/types/progress";
import { PLAN_ACTIVITY_TYPES } from "@/types/plan";
import { AGENT_ACTIVITY_KINDS } from "@/types/agent-activity";
import { TEACH_BACK_UNDERSTANDING_LEVELS } from "@/types/teach-back";

// Completeness checks: every server-defined enum value must have a presentation label, so a future
// phase adding a new enum value can't silently render "undefined" in the UI.

test("every MasteryStage has a label and a distinct glyph", () => {
  for (const stage of MASTERY_STAGES) {
    assert.ok(STAGE_LABEL[stage], `missing STAGE_LABEL for ${stage}`);
    assert.ok(STAGE_GLYPH[stage], `missing STAGE_GLYPH for ${stage}`);
  }
});

test("every PedagogicalAction has a learner-friendly label", () => {
  for (const action of PEDAGOGICAL_ACTIONS) {
    assert.ok(ACTION_LABEL[action], `missing ACTION_LABEL for ${action}`);
  }
});

test("every ScaffoldingLevel/DifficultyBand/TransferReadiness/CalibrationState has a label", () => {
  for (const level of ["HIGH_SUPPORT", "STANDARD", "LOW_SUPPORT"] as const) assert.ok(SCAFFOLDING_LABEL[level]);
  for (const band of ["easy", "medium", "hard"] as const) assert.ok(DIFFICULTY_LABEL[band]);
  for (const t of ["not_attempted", "attempted", "ready"] as const) assert.ok(TRANSFER_LABEL[t]);
  for (const s of ["insufficient_evidence", "well_calibrated", "overconfident", "underconfident"] as const) assert.ok(CALIBRATION_LABEL[s]);
});

test("every PedagogicalReasonCode has a why-this-approach label (Phase 13, Step 9)", () => {
  for (const code of PEDAGOGICAL_REASON_CODES) {
    assert.ok(PEDAGOGICAL_REASON_LABEL[code], `missing PEDAGOGICAL_REASON_LABEL for ${code}`);
  }
});

test("no revision-reason label uses insulting/absolute language (Step 41)", () => {
  const banned = /\b(bad at|poor student|weak learner|stupid|fail(?:ure|ed)?\b)/i;
  for (const label of Object.values(REVISION_REASON_LABEL)) {
    assert.doesNotMatch(label, banned, `"${label}" reads as judgmental, not evidence-specific`);
  }
});

test("every PlanActivityType has a type label and a CTA label (Week 4, Phase 5)", () => {
  for (const type of PLAN_ACTIVITY_TYPES) {
    assert.ok(PLAN_ACTIVITY_TYPE_LABEL[type], `missing PLAN_ACTIVITY_TYPE_LABEL for ${type}`);
    assert.ok(PLAN_ACTIVITY_CTA_LABEL[type], `missing PLAN_ACTIVITY_CTA_LABEL for ${type}`);
  }
});

test("every AgentActivityKind has a readable label, including NEXT_ACTION_SELECTED which has no call site yet (Week 4, Phase C)", () => {
  for (const kind of AGENT_ACTIVITY_KINDS) {
    assert.ok(AGENT_ACTIVITY_KIND_LABEL[kind], `missing AGENT_ACTIVITY_KIND_LABEL for ${kind}`);
  }
});

test("every TeachBackUnderstanding level has a readable label (final standout feature)", () => {
  for (const level of TEACH_BACK_UNDERSTANDING_LEVELS) {
    assert.ok(TEACH_BACK_UNDERSTANDING_LABEL[level], `missing TEACH_BACK_UNDERSTANDING_LABEL for ${level}`);
  }
});

test("revisionIntentLabel prioritizes prerequisite > misconception > review > transfer > plateau > continue, deterministically", () => {
  assert.equal(revisionIntentLabel(["PREREQUISITE_BLOCKER", "ACTIVE_MISCONCEPTION"]), "Prerequisite needed");
  assert.equal(revisionIntentLabel(["ACTIVE_MISCONCEPTION", "REVIEW_DUE"]), "Misconception to address");
  assert.equal(revisionIntentLabel(["REVIEW_DUE"]), "Review now");
  assert.equal(revisionIntentLabel(["TRANSFER_NOT_DEMONSTRATED"]), "Practice application");
  assert.equal(revisionIntentLabel(["PRACTICE_PLATEAU"]), "Keep practicing");
  assert.equal(revisionIntentLabel(["MASTERY_DEVELOPING"]), "Continue learning");
  assert.equal(revisionIntentLabel([]), "Continue learning");
});
