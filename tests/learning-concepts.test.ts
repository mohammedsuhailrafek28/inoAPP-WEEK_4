import assert from "node:assert/strict";
import test from "node:test";
import {
  ConceptCycleError,
  ConceptValidationError,
  addPrerequisite,
  checkWouldCreateCycle,
  computeDepth,
  computeTopologicalOrder,
  createOrResolveConcept,
  getAncestorClosure,
  getConceptByKey,
  getDependentClosure,
  getDescendantClosure,
  getPrerequisiteClosure,
  getPrerequisiteLearningOrder,
  getStructuralPrerequisiteInfo,
  listConcepts,
  listConceptsBySubject,
  listDependents,
  listPrerequisites,
  normalizeConceptKey,
  normalizeSubjectKey,
  removePrerequisite,
  resolveConcept,
  wouldCreateCycle,
} from "@/lib/learning/concepts";
import { createFakeLearningSupabase } from "./support/fake-learning-db";
import type { ConceptGraphEdge } from "@/types/learning";

function deps() {
  const fake = createFakeLearningSupabase();
  return { supabase: fake as never, fake };
}

// ------------------------------------------------------------------------------------------
// Normalization (Step 6, Step 20)
// ------------------------------------------------------------------------------------------

test("normalizeConceptKey collapses whitespace/case/separator variants to the same key", () => {
  assert.equal(normalizeConceptKey("Binary Search"), "binary-search");
  assert.equal(normalizeConceptKey("binary search"), "binary-search");
  assert.equal(normalizeConceptKey("binary-search"), "binary-search");
  assert.equal(normalizeConceptKey("  Binary   Search  "), "binary-search");
  assert.equal(normalizeConceptKey("Rabin_Karp"), "rabin-karp");
  assert.equal(normalizeConceptKey("Machine Learning"), "machine-learning");
});

test("normalizeConceptKey strips one trailing generic suffix only", () => {
  assert.equal(normalizeConceptKey("binary search algorithm"), "binary-search");
  assert.equal(normalizeConceptKey("Rabin-Karp Algorithm"), "rabin-karp");
  assert.equal(normalizeConceptKey("Newton's Method"), "newton-s");
});

test("normalizeConceptKey is deterministic and idempotent", () => {
  const once = normalizeConceptKey("  Binary   Search  ");
  const twice = normalizeConceptKey(once);
  assert.equal(once, twice);
});

test("normalizeConceptKey rejects an empty-after-normalization or non-string input", () => {
  assert.throws(() => normalizeConceptKey("   "), ConceptValidationError);
  assert.throws(() => normalizeConceptKey("!!!"), ConceptValidationError);
  assert.throws(() => normalizeConceptKey(42 as never), ConceptValidationError);
});

test("normalizeConceptKey enforces a maximum length", () => {
  assert.throws(() => normalizeConceptKey("x".repeat(81)), ConceptValidationError);
  assert.equal(normalizeConceptKey("x".repeat(80)), "x".repeat(80));
});

test("normalizeConceptKey never merges semantically different concepts by heuristic", () => {
  // Related but distinct -- must NOT collapse to the same key just because they're similar strings.
  assert.notEqual(normalizeConceptKey("hash table"), normalizeConceptKey("hashing"));
});

test("normalizeSubjectKey normalizes the same way, without generic-suffix stripping", () => {
  assert.equal(normalizeSubjectKey("Data Structures"), "data-structures");
  assert.equal(normalizeSubjectKey("data-structures"), "data-structures");
  assert.equal(normalizeSubjectKey("DATA_STRUCTURES"), "data-structures");
  assert.throws(() => normalizeSubjectKey("   "), ConceptValidationError);
  assert.throws(() => normalizeSubjectKey("x".repeat(61)), ConceptValidationError);
});

// ------------------------------------------------------------------------------------------
// Concept registry (Step 20)
// ------------------------------------------------------------------------------------------

test("createOrResolveConcept creates a new concept with normalized identity", async () => {
  const { supabase } = deps();
  const { concept, wasCreated } = await createOrResolveConcept({ subject: "Algorithms", displayName: "Binary Search" }, { supabase });
  assert.equal(wasCreated, true);
  assert.equal(concept.subject, "algorithms");
  assert.equal(concept.conceptKey, "binary-search");
  assert.equal(concept.displayName, "Binary Search");
  assert.deepEqual(concept.aliases, []);
});

test("a different display-name spelling resolves to the same canonical concept, recorded as an alias", async () => {
  const { supabase, fake } = deps();
  const first = await createOrResolveConcept({ subject: "algorithms", displayName: "Binary Search" }, { supabase });
  const second = await createOrResolveConcept({ subject: "algorithms", displayName: "binary-search" }, { supabase });
  assert.equal(first.concept.id, second.concept.id);
  assert.equal(second.wasCreated, false);
  assert.deepEqual(second.concept.aliases, ["binary-search"]);
  assert.equal(fake.tables.concepts.rows.length, 1); // never a second row for the same canonical identity
});

test("same display name never accidentally creates two conflicting canonical identities across subjects", async () => {
  // concept_key is globally unique (ARCHITECTURE.md §6's exact SQL: "concept_key text
  // UNIQUE", not scoped per subject) -- the second call resolves to the first concept's subject,
  // it does not silently create a second "Arrays" under a different subject.
  const { supabase, fake } = deps();
  const first = await createOrResolveConcept({ subject: "data-structures", displayName: "Arrays" }, { supabase });
  const second = await createOrResolveConcept({ subject: "machine-learning", displayName: "Arrays" }, { supabase });
  assert.equal(first.concept.id, second.concept.id);
  assert.equal(second.concept.subject, "data-structures");
  assert.equal(fake.tables.concepts.rows.length, 1);
});

test("rejects an empty or oversized display name", async () => {
  const { supabase } = deps();
  await assert.rejects(() => createOrResolveConcept({ subject: "algorithms", displayName: "" }, { supabase }), ConceptValidationError);
  await assert.rejects(() => createOrResolveConcept({ subject: "algorithms", displayName: "x".repeat(121) }, { supabase }), ConceptValidationError);
});

test("listConceptsBySubject and listConcepts group correctly", async () => {
  const { supabase } = deps();
  await createOrResolveConcept({ subject: "algorithms", displayName: "Hashing" }, { supabase });
  await createOrResolveConcept({ subject: "algorithms", displayName: "Rolling Hash" }, { supabase });
  await createOrResolveConcept({ subject: "machine-learning", displayName: "Linear Regression" }, { supabase });

  const algorithms = await listConceptsBySubject("Algorithms", { supabase }); // note: unnormalized input
  assert.equal(algorithms.length, 2);
  assert.ok(algorithms.every((c) => c.subject === "algorithms"));

  const all = await listConcepts({ supabase });
  assert.equal(all.length, 3);
});

test("getConceptByKey looks up by canonical identity", async () => {
  const { supabase } = deps();
  const { concept } = await createOrResolveConcept({ subject: "algorithms", displayName: "Hashing" }, { supabase });
  const found = await getConceptByKey("hashing", { supabase });
  assert.equal(found?.id, concept.id);
  assert.equal(await getConceptByKey("nonexistent", { supabase }), null);
});

test("resolveConcept resolves by id or by {subject, displayName}, always through normalization", async () => {
  const { supabase } = deps();
  const created = await createOrResolveConcept({ subject: "algorithms", displayName: "Hashing" }, { supabase });
  const byId = await resolveConcept({ conceptId: created.concept.id }, { supabase });
  assert.equal(byId.concept.id, created.concept.id);

  const byReference = await resolveConcept({ subject: "algorithms", displayName: "hashing" }, { supabase });
  assert.equal(byReference.concept.id, created.concept.id);

  await assert.rejects(() => resolveConcept({ conceptId: "00000000-0000-0000-0000-000000000000" }, { supabase }), ConceptValidationError);
});

// ------------------------------------------------------------------------------------------
// Prerequisites (Step 20)
// ------------------------------------------------------------------------------------------

async function seedChain(supabase: never) {
  const hashing = await createOrResolveConcept({ subject: "algorithms", displayName: "Hashing" }, { supabase });
  const rollingHash = await createOrResolveConcept({ subject: "algorithms", displayName: "Rolling Hash" }, { supabase });
  const rabinKarp = await createOrResolveConcept({ subject: "algorithms", displayName: "Rabin-Karp" }, { supabase });
  await addPrerequisite(rollingHash.concept.id, hashing.concept.id, { supabase }); // rolling-hash requires hashing
  await addPrerequisite(rabinKarp.concept.id, rollingHash.concept.id, { supabase }); // rabin-karp requires rolling-hash
  return { hashing: hashing.concept, rollingHash: rollingHash.concept, rabinKarp: rabinKarp.concept };
}

test("A requires B succeeds and is queryable both directions", async () => {
  const { supabase } = deps();
  const { hashing, rollingHash } = await seedChain(supabase);
  const prereqs = await listPrerequisites(rollingHash.id, { supabase });
  assert.equal(prereqs.length, 1);
  assert.equal(prereqs[0].id, hashing.id);

  const dependents = await listDependents(hashing.id, { supabase });
  assert.equal(dependents.length, 1);
  assert.equal(dependents[0].id, rollingHash.id);
});

test("re-adding the same edge is an idempotent no-op, not an error", async () => {
  const { supabase, fake } = deps();
  const { hashing, rollingHash } = await seedChain(supabase);
  await addPrerequisite(rollingHash.id, hashing.id, { supabase });
  assert.equal(fake.tables.prerequisites.rows.length, 2); // still just the 2 edges from seedChain
});

test("a concept cannot be its own prerequisite", async () => {
  const { supabase } = deps();
  const { hashing } = await seedChain(supabase);
  await assert.rejects(() => addPrerequisite(hashing.id, hashing.id, { supabase }), ConceptCycleError);
});

test("an indirect cycle (C -> A when A -> B -> C already exists) is rejected", async () => {
  const { supabase } = deps();
  const { hashing, rabinKarp } = await seedChain(supabase);
  await assert.rejects(() => addPrerequisite(hashing.id, rabinKarp.id, { supabase }), ConceptCycleError);
});

test("the cycle error message resolves EVERY node in the path, not just the two new-edge endpoints", async () => {
  // Regression test for a bug caught during Phase 2's live Supabase smoke test: the error
  // message initially left an intermediate concept's raw UUID unresolved.
  const { supabase } = deps();
  const { hashing, rollingHash, rabinKarp } = await seedChain(supabase);
  await assert.rejects(
    () => addPrerequisite(hashing.id, rabinKarp.id, { supabase }),
    (error: unknown) => {
      assert.ok(error instanceof ConceptCycleError);
      const message = (error as Error).message;
      assert.match(message, /rabin-karp/);
      assert.match(message, /rolling-hash/); // the intermediate node -- must not appear as a raw UUID
      assert.match(message, /hashing/);
      assert.doesNotMatch(message, new RegExp(rollingHash.id));
      return true;
    },
  );
});

test("checkWouldCreateCycle reports the cycle path without mutating anything", async () => {
  const { supabase, fake } = deps();
  const { hashing, rabinKarp } = await seedChain(supabase);
  const cycle = await checkWouldCreateCycle(hashing.id, rabinKarp.id, { supabase });
  assert.ok(cycle && cycle.length > 0);
  assert.equal(fake.tables.prerequisites.rows.length, 2); // unchanged -- read-only
});

test("transitive prerequisite closure and dependent closure are correct along a 3-deep chain", async () => {
  const { supabase } = deps();
  const { hashing, rollingHash, rabinKarp } = await seedChain(supabase);

  const closure = await getPrerequisiteClosure(rabinKarp.id, { supabase });
  assert.deepEqual(new Set(closure.map((c) => c.id)), new Set([hashing.id, rollingHash.id]));

  const dependentClosure = await getDependentClosure(hashing.id, { supabase });
  assert.deepEqual(new Set(dependentClosure.map((c) => c.id)), new Set([rollingHash.id, rabinKarp.id]));
});

test("getStructuralPrerequisiteInfo reports direct prerequisites, transitive count, and depth", async () => {
  const { supabase } = deps();
  const { hashing, rollingHash, rabinKarp } = await seedChain(supabase);

  const info = await getStructuralPrerequisiteInfo(rabinKarp.id, { supabase });
  assert.equal(info.directPrerequisites.length, 1);
  assert.equal(info.directPrerequisites[0].id, rollingHash.id);
  assert.equal(info.transitivePrerequisiteCount, 2);
  assert.equal(info.depth, 2);

  const rootInfo = await getStructuralPrerequisiteInfo(hashing.id, { supabase });
  assert.equal(rootInfo.depth, 0);
  assert.equal(rootInfo.transitivePrerequisiteCount, 0);
});

test("getPrerequisiteLearningOrder returns a deterministic topological order, target excluded", async () => {
  const { supabase } = deps();
  const { hashing, rollingHash, rabinKarp } = await seedChain(supabase);
  const path = await getPrerequisiteLearningOrder(rabinKarp.id, { supabase });
  assert.deepEqual(path.order.map((c) => c.id), [hashing.id, rollingHash.id]);
});

test("removePrerequisite removes exactly the one edge", async () => {
  const { supabase, fake } = deps();
  const { hashing, rollingHash } = await seedChain(supabase);
  await removePrerequisite(rollingHash.id, hashing.id, { supabase });
  assert.equal(fake.tables.prerequisites.rows.length, 1);
  assert.equal((await listPrerequisites(rollingHash.id, { supabase })).length, 0);
});

// ------------------------------------------------------------------------------------------
// Multi-branch DAG (Step 20): A -> C, B -> C, C -> D
// ------------------------------------------------------------------------------------------

test("multi-branch DAG: topological order is valid and stable regardless of independent-branch insertion order", async () => {
  const { supabase } = deps();
  const a = await createOrResolveConcept({ subject: "algorithms", displayName: "A" }, { supabase });
  const b = await createOrResolveConcept({ subject: "algorithms", displayName: "B" }, { supabase });
  const c = await createOrResolveConcept({ subject: "algorithms", displayName: "C" }, { supabase });
  const d = await createOrResolveConcept({ subject: "algorithms", displayName: "D" }, { supabase });
  await addPrerequisite(c.concept.id, a.concept.id, { supabase }); // C requires A
  await addPrerequisite(c.concept.id, b.concept.id, { supabase }); // C requires B
  await addPrerequisite(d.concept.id, c.concept.id, { supabase }); // D requires C

  const path = await getPrerequisiteLearningOrder(d.concept.id, { supabase });
  const keys = path.order.map((n) => n.conceptKey);
  assert.deepEqual(keys, ["a", "b", "c"]); // alphabetical tie-break between independent A/B, then C

  // A valid topological order must place both A and B before C, and C before D (D excluded).
  assert.ok(keys.indexOf("a") < keys.indexOf("c"));
  assert.ok(keys.indexOf("b") < keys.indexOf("c"));
});

test("pure wouldCreateCycle/closure/order functions work directly on plain edge arrays (no DB needed)", () => {
  // c requires a, c requires b, d requires c  (i.e. a and b are prerequisites of c; c is a
  // prerequisite of d) -- the same A->C, B->C, C->D shape as the multi-branch DAG test above.
  const edges: ConceptGraphEdge[] = [
    { conceptId: "c", prerequisiteConceptId: "a" },
    { conceptId: "c", prerequisiteConceptId: "b" },
    { conceptId: "d", prerequisiteConceptId: "c" },
  ];
  // d already transitively requires a (d -> c -> a), so "a requires d" would close a cycle.
  assert.ok(wouldCreateCycle(edges, "a", "d"));
  // c already directly requires a, so "a requires c" would close a cycle too.
  assert.ok(wouldCreateCycle(edges, "a", "c"));
  // "e" is unconnected to the graph -- "e requires d" is perfectly safe.
  assert.equal(wouldCreateCycle(edges, "e", "d"), null);

  assert.deepEqual([...getAncestorClosure(edges, "d")].sort(), ["a", "b", "c"]);
  assert.deepEqual([...getDescendantClosure(edges, "a")].sort(), ["c", "d"]);
  assert.equal(computeDepth(edges, "d"), 2);
  assert.deepEqual(computeTopologicalOrder(edges, "d", (id) => id), ["a", "b", "c"]);
});
