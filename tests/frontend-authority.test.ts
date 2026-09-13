import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

// Step 37 (mandatory, Phase 12): structurally verify the frontend never implements BKT/IRT/FSRS,
// the revision formula, pedagogical precedence, mastery-stage derivation, transfer/calibration
// calculation, or correctness scoring -- it only ever consumes server results. This is the same
// grep-based structural-regression style already established by
// tests/learning-integration.test.ts's "one RAG path" test, applied to the whole client surface.

function clientSourceFiles(): string[] {
  const componentsDir = path.join(process.cwd(), "components");
  const files = readdirSync(componentsDir)
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => path.join(componentsDir, f));
  files.push(path.join(process.cwd(), "app", "page.tsx"));
  files.push(path.join(process.cwd(), "lib", "ui", "labels.ts"));
  return files;
}

test("no client component imports a server-only learning/pedagogy/quiz module", () => {
  for (const file of clientSourceFiles()) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /from ["']@\/lib\/learning\//, `${file} must not import lib/learning/* (server-only, and would duplicate authoritative logic client-side)`);
    assert.doesNotMatch(source, /from ["']@\/lib\/pedagogy\//, `${file} must not import lib/pedagogy/* (server-only)`);
    assert.doesNotMatch(source, /from ["']@\/lib\/quiz\//, `${file} must not import lib/quiz/* (server-only)`);
    assert.doesNotMatch(source, /from ["']@\/lib\/personalization\//, `${file} must not import lib/personalization/* (server-only)`);
    assert.doesNotMatch(source, /from ["']@supabase\/supabase-js["']/, `${file} must not talk to Supabase directly -- only the server's own API routes do`);
  }
});

test("no client component computes a BKT/IRT/FSRS-shaped formula or raw internal metric", () => {
  const suspiciousTokens = [/p_?[Mm]astery\s*[*+\-/]/, /\btheta\b\s*[*+\-]/, /retrievability\s*[*+\-]/, /pfaScore/, /sigmoid\(/, /calculateRetrievability/, /applyBktUpdate/, /updateTheta/];
  for (const file of clientSourceFiles()) {
    const source = readFileSync(file, "utf8");
    for (const pattern of suspiciousTokens) {
      assert.doesNotMatch(source, pattern, `${file} must not compute a raw learner-model formula client-side (matched ${pattern})`);
    }
  }
});

test("no client component derives correctness -- MCQ scoring stays server-side", () => {
  for (const file of clientSourceFiles()) {
    const source = readFileSync(file, "utf8");
    // The only legitimate appearance of "correct" is READING a server-returned boolean
    // (result.correct / row.correct), never assigning/computing one from a comparison the
    // client performs itself.
    assert.doesNotMatch(source, /\bcorrect\s*=\s*[a-zA-Z_]+\s*===/, `${file} must never compute its own correctness verdict`);
  }
});

test("no client component re-derives the §23 revision-priority formula or the §17.3 action cascade", () => {
  for (const file of clientSourceFiles()) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /0\.35\s*\*/, `${file} must not re-implement §23's weighted formula`);
    assert.doesNotMatch(source, /if\s*\(\s*stage\s*===\s*["']DEVELOPING["']/i, `${file} must not branch pedagogically on stage the way the server's own cascade does -- it may only branch on PRESENTATION (labels/styling)`);
  }
});

test("New Chat clears only conversation state -- it never calls a learning-mutation endpoint or the learning API surface at all", () => {
  const source = readFileSync(path.join(process.cwd(), "app", "page.tsx"), "utf8");
  const match = source.match(/const handleClear = useCallback\(\(\) => \{[\s\S]*?\}, \[\]\);/);
  assert.ok(match, "expected to find handleClear");
  const body = match![0];
  assert.doesNotMatch(body, /fetch\(/);
  assert.doesNotMatch(body, /learning/i);
  assert.match(body, /setMessages\(\[\]\)/);
});

test("the Progress/Practice/Profile/Plan panels only ever call existing, already-tested API routes -- no new endpoint was invented for frontend convenience", () => {
  const allowedPrefixes = ["/api/rag", "/api/chat", "/api/documents", "/api/profile", "/api/learning/progress", "/api/learning/concepts", "/api/learning/plan", "/api/learning/goal-plan", "/api/learning/intervention", "/api/learning/teach-back", "/api/quiz/generate", "/api/quiz/", "/api/materials/notes", "/api/materials/flashcards", "/api/agent-activity"];
  for (const file of clientSourceFiles()) {
    const source = readFileSync(file, "utf8");
    const calls = [...source.matchAll(/fetch\(\s*(?:`|")(\/api\/[^`"$]*)/g)].map((m) => m[1]);
    for (const call of calls) {
      assert.ok(allowedPrefixes.some((prefix) => call.startsWith(prefix)), `${file} calls an unexpected API route: ${call}`);
    }
  }
});
