// DEVELOPMENT/DEMO-ONLY. Not part of the product runtime -- never imported by app/ or lib/.
//
// Seeds the minimum learner evidence needed to visually demonstrate the Week 4 autonomous planner
// against the linked development Supabase project, using ONLY the same trusted internal write path
// real quiz submissions use: lib/learning/reviews.ts::recordScoredOutcomeWithRetention() (BKT + IRT
// + FSRS in one call, exactly as lib/quiz/service.ts::submitQuizAnswer() already does). No raw SQL,
// no direct table writes, no manually-assigned mastery/retention value, no manually-assigned
// recommendation reason code -- every downstream signal (mastery, priority, prerequisite blocking,
// transfer-not-demonstrated) is derived entirely by the existing, unmodified algorithms once this
// script's evidence lands.
//
// Idempotent by construction: every call below carries a deterministic idempotencyKey
// ("week4-demo-seed:<conceptKey>:<n>"). recordLearningEvent()'s own UNIQUE(student_id,
// idempotency_key) index (migration 004) means a second run of this script finds each event
// already exists and returns it unchanged; recordScoredOutcomeWithRetention() then reuses that same
// event id for BKT/IRT/FSRS, whose own UNIQUE(source_event_id) ledgers report `alreadyProcessed:
// true` and apply nothing a second time. Running this script twice is therefore safe and does not
// compound evidence -- verified below by an explicit "second run" report line.
//
// Identification for later cleanup: every event this script writes has an idempotency_key starting
// with "week4-demo-seed:". No schema change was made to add this marker -- idempotency_key already
// existed for exactly this purpose (ARCHITECTURE.md §20/migration 004).
//
// Run: npx tsx scripts/seed-week4-demo.ts

import { readFileSync } from "node:fs";
import path from "node:path";

// Plain node/tsx does not auto-load .env.local the way `next dev`/`next build` do -- load it here,
// without adding a new dependency, so this script can reach the same linked Supabase project the
// app itself uses.
function loadEnvLocal(): void {
  const envPath = path.join(process.cwd(), ".env.local");
  let contents: string;
  try {
    contents = readFileSync(envPath, "utf8");
  } catch {
    return;
  }
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnvLocal();

import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { getConceptByKey } from "@/lib/learning/concepts";
import { getMasteryState } from "@/lib/learning/mastery";
import { recordScoredOutcomeWithRetention } from "@/lib/learning/reviews";
import { getRevisionRecommendations } from "@/lib/learning/recommendations";
import { selectNextActivity } from "@/lib/pedagogy/select";

const SUBJECT = "algorithms";
const IDEMPOTENCY_PREFIX = "week4-demo-seed";

// The existing prerequisite chain from supabase/seed.sql: hashing -> rolling-hash -> rabin-karp.
// hashing gets strong (mastered) evidence, rabin-karp gets weak evidence, rolling-hash is left
// completely untouched -- its own zero evidence is what makes rabin-karp genuinely prerequisite-
// blocked under the existing readiness algorithm (lib/learning/readiness.ts), never asserted by hand.
const PLAN: { conceptKey: string; outcomes: ("correct" | "incorrect")[] }[] = [
  { conceptKey: "hashing", outcomes: Array(5).fill("correct") },
  { conceptKey: "rabin-karp", outcomes: Array(3).fill("incorrect") },
  // "rolling-hash" intentionally has no entry here -- zero evidence is the point.
];

async function summarize(studentId: string, label: string) {
  console.log(`\n=== ${label}: learner state for subject "${SUBJECT}" ===`);
  for (const key of ["hashing", "rolling-hash", "rabin-karp"]) {
    const concept = await getConceptByKey(key);
    if (!concept) {
      console.log(`  ${key}: concept not found`);
      continue;
    }
    const mastery = await getMasteryState(studentId, concept.id);
    console.log(`  ${key.padEnd(14)} evidence=${mastery?.evidenceCount ?? 0} pMastery=${mastery ? mastery.pMastery.toFixed(3) : "null"}`);
  }

  const { recommendations, transferPractice } = await getRevisionRecommendations(studentId, { subject: SUBJECT });
  console.log("  recommendations (priority-ranked, prerequisite order enforced):");
  if (recommendations.length === 0) console.log("    (none)");
  for (const r of recommendations) console.log(`    - ${r.conceptKey.padEnd(14)} priority=${r.priority.toFixed(3)} reasons=[${r.reasonCodes.join(", ")}]`);
  console.log("  transferPractice (additive, mastered-but-not-transferred):");
  if (transferPractice.length === 0) console.log("    (none)");
  for (const r of transferPractice) console.log(`    - ${r.conceptKey.padEnd(14)} reasons=[${r.reasonCodes.join(", ")}]`);

  const nextActivity = await selectNextActivity(studentId, SUBJECT);
  console.log(`  next best action: ${nextActivity.decision?.action ?? "(none)"} on ${nextActivity.decision?.targetConceptKey ?? "(none)"} [${nextActivity.decision?.reasonCodes.join(", ") ?? ""}]`);
}

async function seed(studentId: string) {
  for (const { conceptKey, outcomes } of PLAN) {
    const concept = await getConceptByKey(conceptKey);
    if (!concept) throw new Error(`Expected seeded concept "${conceptKey}" in subject "${SUBJECT}" -- run supabase/seed.sql first.`);
    for (let i = 0; i < outcomes.length; i++) {
      const idempotencyKey = `${IDEMPOTENCY_PREFIX}:${conceptKey}:${i + 1}`;
      const result = await recordScoredOutcomeWithRetention({ studentId, conceptId: concept.id, outcome: outcomes[i], difficulty: "medium", idempotencyKey });
      console.log(`  seeded ${conceptKey} #${i + 1} (${outcomes[i]}) -- alreadyProcessed=${result.bkt.alreadyProcessed}`);
    }
  }
}

async function main() {
  const profile = await getOrCreateDefaultProfile();
  console.log(`Using student profile: ${profile.id}`);

  await summarize(profile.id, "BEFORE");

  console.log(`\n=== Seeding via recordScoredOutcomeWithRetention() (idempotencyKey prefix "${IDEMPOTENCY_PREFIX}:") ===`);
  await seed(profile.id);

  await summarize(profile.id, "AFTER (first run)");

  console.log("\n=== Re-running seed() to verify idempotency (no evidence should compound) ===");
  await seed(profile.id);

  await summarize(profile.id, "AFTER (second run -- must be identical to first run)");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
