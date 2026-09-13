import assert from "node:assert/strict";
import test from "node:test";
import { ProfileValidationError, getOrCreateDefaultProfile, getProfile, updateProfile } from "@/lib/learning/profile";
import { createFakeLearningSupabase } from "./support/fake-learning-db";

function deps() {
  const fake = createFakeLearningSupabase();
  return { supabase: fake as never, fake };
}

test("getProfile returns null before any profile has been created", async () => {
  const { supabase } = deps();
  assert.equal(await getProfile({ supabase }), null);
});

test("getOrCreateDefaultProfile bootstraps a single placeholder row with sensible defaults", async () => {
  const { supabase, fake } = deps();
  const profile = await getOrCreateDefaultProfile({ supabase });
  assert.equal(profile.displayName, "Student");
  assert.equal(profile.academicLevel, "Not specified");
  assert.equal(profile.preferredExplanationStyle, "simple");
  assert.equal(profile.preferredDifficulty, "auto");
  assert.equal(profile.preferredPace, "standard");
  assert.equal(fake.tables.profiles.rows.length, 1);

  // Calling it again never creates a second row -- single-user Auth Decision (unchanged from
  // Revision 1): exactly one student_profiles row.
  const again = await getOrCreateDefaultProfile({ supabase });
  assert.equal(again.id, profile.id);
  assert.equal(fake.tables.profiles.rows.length, 1);
});

test("updateProfile applies a valid partial patch and leaves omitted fields untouched", async () => {
  const { supabase } = deps();
  const created = await updateProfile({ displayName: "Asha", academicLevel: "undergrad-cs-2nd-year" }, { supabase });
  assert.equal(created.displayName, "Asha");
  assert.equal(created.academicLevel, "undergrad-cs-2nd-year");
  assert.equal(created.preferredPace, "standard"); // untouched default

  const updated = await updateProfile({ preferredPace: "accelerated" }, { supabase });
  assert.equal(updated.displayName, "Asha"); // still there -- omitted, not reset
  assert.equal(updated.preferredPace, "accelerated");
});

test("valid subjects are trimmed, deduplicated case-insensitively, and bounded to 10", async () => {
  const { supabase } = deps();
  const profile = await updateProfile({ subjects: ["  Algorithms ", "algorithms", "Databases"] }, { supabase });
  assert.deepEqual(profile.subjects, ["Algorithms", "Databases"]);

  await assert.rejects(
    () => updateProfile({ subjects: Array.from({ length: 11 }, (_, i) => `subject-${i}`) }, { supabase }),
    ProfileValidationError,
  );
});

test("rejects an invalid enum value", async () => {
  const { supabase } = deps();
  await assert.rejects(
    () => updateProfile({ preferredExplanationStyle: "socratic" as never }, { supabase }),
    ProfileValidationError,
  );
  await assert.rejects(() => updateProfile({ preferredDifficulty: "impossible" as never }, { supabase }), ProfileValidationError);
  await assert.rejects(() => updateProfile({ preferredPace: "warp-speed" as never }, { supabase }), ProfileValidationError);
});

test("rejects oversized text fields", async () => {
  const { supabase } = deps();
  await assert.rejects(() => updateProfile({ displayName: "x".repeat(81) }, { supabase }), ProfileValidationError);
  await assert.rejects(() => updateProfile({ academicLevel: "x".repeat(61) }, { supabase }), ProfileValidationError);
  await assert.rejects(() => updateProfile({ learningGoals: "x".repeat(501) }, { supabase }), ProfileValidationError);
  await assert.rejects(() => updateProfile({ examplePreference: "x".repeat(501) }, { supabase }), ProfileValidationError);
  await assert.rejects(() => updateProfile({ subjects: ["x".repeat(41)] }, { supabase }), ProfileValidationError);
});

test("rejects a malformed request payload", async () => {
  const { supabase } = deps();
  await assert.rejects(() => updateProfile(null as never, { supabase }), ProfileValidationError);
  await assert.rejects(() => updateProfile([] as never, { supabase }), ProfileValidationError);
  await assert.rejects(() => updateProfile({ displayName: 42 as never }, { supabase }), ProfileValidationError);
  await assert.rejects(() => updateProfile({ subjects: "not-an-array" as never }, { supabase }), ProfileValidationError);
});

test("unknown fields (e.g. pseudoscientific learning-style labels) are silently ignored, never persisted", async () => {
  const { supabase } = deps();
  const withExtra = { displayName: "Asha", visualLearner: true, auditoryLearner: false } as unknown as Parameters<typeof updateProfile>[0];
  const profile = await updateProfile(withExtra, { supabase });
  assert.equal(profile.displayName, "Asha");
  assert.ok(!("visualLearner" in profile));
  assert.ok(!("auditoryLearner" in profile));
});
