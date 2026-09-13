import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { recordAgentActivity, listAgentActivity, AgentActivityValidationError } from "@/lib/learning/agent-activity";
import { createFakeLearningSupabase } from "./support/fake-learning-db";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";

async function setup() {
  const fake = createFakeLearningSupabase();
  const supabase = fake as never;
  const profile = await getOrCreateDefaultProfile({ supabase });
  return { supabase, fake, studentId: profile.id };
}

test("records a PLAN_GENERATED row with the expected fields", async () => {
  const { supabase, studentId } = await setup();
  const record = await recordAgentActivity({ studentId, subject: "machine-learning", kind: "PLAN_GENERATED", conceptId: "concept-1", conceptKey: "linear-regression", reasonCodes: ["REVIEW_DUE"], metadata: { availableMinutes: 60 } }, { supabase });
  assert.equal(record.studentId, studentId);
  assert.equal(record.subject, "machine-learning");
  assert.equal(record.kind, "PLAN_GENERATED");
  assert.equal(record.conceptKey, "linear-regression");
  assert.deepEqual(record.reasonCodes, ["REVIEW_DUE"]);
  assert.equal(record.metadata.availableMinutes, 60);
  assert.ok(record.id);
  assert.ok(record.createdAt);
});

test("accepts every real (emittable) activity kind: PLAN_GENERATED, PLAN_REPLANNED, MATERIAL_GENERATED", async () => {
  const { supabase, studentId } = await setup();
  for (const kind of ["PLAN_GENERATED", "PLAN_REPLANNED", "MATERIAL_GENERATED"] as const) {
    const record = await recordAgentActivity({ studentId, subject: "algorithms", kind }, { supabase });
    assert.equal(record.kind, kind);
  }
});

test("rejects an unsupported kind (e.g. NEXT_ACTION_SELECTED has no call site yet) with a validation error", async () => {
  const { supabase, studentId } = await setup();
  await assert.rejects(() => recordAgentActivity({ studentId, subject: "algorithms", kind: "NEXT_ACTION_SELECTED" as never }, { supabase }), AgentActivityValidationError);
  await assert.rejects(() => recordAgentActivity({ studentId, subject: "algorithms", kind: "SOMETHING_ELSE" as never }, { supabase }), AgentActivityValidationError);
});

test("rejects a missing studentId or subject", async () => {
  const { supabase } = await setup();
  await assert.rejects(() => recordAgentActivity({ studentId: "", subject: "algorithms", kind: "PLAN_GENERATED" }, { supabase }), AgentActivityValidationError);
  await assert.rejects(() => recordAgentActivity({ studentId: "s1", subject: "", kind: "PLAN_GENERATED" }, { supabase }), AgentActivityValidationError);
});

test("defaults conceptId/conceptKey/reasonCodes/metadata when omitted", async () => {
  const { supabase, studentId } = await setup();
  const record = await recordAgentActivity({ studentId, subject: "algorithms", kind: "PLAN_GENERATED" }, { supabase });
  assert.equal(record.conceptId, null);
  assert.equal(record.conceptKey, null);
  assert.deepEqual(record.reasonCodes, []);
  assert.deepEqual(record.metadata, {});
});

test("listAgentActivity returns most-recent-first and respects the subject filter", async () => {
  const { supabase, studentId } = await setup();
  await recordAgentActivity({ studentId, subject: "algorithms", kind: "PLAN_GENERATED" }, { supabase });
  await recordAgentActivity({ studentId, subject: "machine-learning", kind: "PLAN_GENERATED" }, { supabase });
  await recordAgentActivity({ studentId, subject: "algorithms", kind: "PLAN_REPLANNED" }, { supabase });

  const all = await listAgentActivity(studentId, {}, { supabase });
  assert.equal(all.length, 3);
  assert.equal(all[0].kind, "PLAN_REPLANNED"); // most recent first

  const algorithmsOnly = await listAgentActivity(studentId, { subject: "algorithms" }, { supabase });
  assert.equal(algorithmsOnly.length, 2);
  assert.ok(algorithmsOnly.every((a) => a.subject === "algorithms"));
});

test("listAgentActivity bounds the returned count and rejects an excessive limit by clamping, never throwing", async () => {
  const { supabase, studentId } = await setup();
  for (let i = 0; i < 5; i++) await recordAgentActivity({ studentId, subject: "algorithms", kind: "PLAN_GENERATED" }, { supabase });
  const limited = await listAgentActivity(studentId, { limit: 2 }, { supabase });
  assert.equal(limited.length, 2);
  const overLimited = await listAgentActivity(studentId, { limit: 1000 }, { supabase }); // clamped to MAX_LIST_LIMIT internally
  assert.ok(overLimited.length <= 50);
});

test("a different student's activity is never returned", async () => {
  const fake = createFakeLearningSupabase();
  const supabase = fake as never;
  const a = await getOrCreateDefaultProfile({ supabase });
  await recordAgentActivity({ studentId: a.id, subject: "algorithms", kind: "PLAN_GENERATED" }, { supabase });
  const activityForOtherStudent = await listAgentActivity("some-other-student-id", {}, { supabase });
  assert.deepEqual(activityForOtherStudent, []);
});

test("append-only: the module exposes no update/delete path for agent_activity_log (mirrors lib/learning/events.ts's own structural guarantee)", () => {
  const source = readFileSync(path.join(process.cwd(), "lib", "learning", "agent-activity.ts"), "utf8");
  assert.doesNotMatch(source, /from\(\s*["']agent_activity_log["']\s*\)\s*\.update\(/);
  assert.doesNotMatch(source, /from\(\s*["']agent_activity_log["']\s*\)\s*\.delete\(/);
  assert.doesNotMatch(source, /export\s+(async\s+)?function\s+(update|delete|remove)/i);
});

test("the migration enforces append-only at the database level via the shared forbid_row_mutation() trigger", () => {
  const migration = readFileSync(path.join(process.cwd(), "supabase", "migrations", "013_agent_activity.sql"), "utf8");
  assert.match(migration, /create trigger agent_activity_log_forbid_update/);
  assert.match(migration, /create trigger agent_activity_log_forbid_delete/);
  assert.match(migration, /forbid_row_mutation/);
});
