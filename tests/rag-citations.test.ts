import assert from "node:assert/strict";
import test from "node:test";
import type { LabeledEvidence, RetrievedEvidence } from "@/types/rag";
import { assignEvidenceLabels, buildCitations, extractSourceLabels, normaliseUsedSources } from "@/lib/documents/citations";

const evidence = (over: Partial<RetrievedEvidence>): RetrievedEvidence => ({
  chunkId: "chunk-1", documentId: "doc-1", filename: "lecture.pdf", pageNumber: 3, ordinalOnPage: 1, text: "source text", similarity: 0.8, ...over,
});

// retrieved: S1 -> lecture.pdf p3 ; S2 -> lecture.pdf p7
const labeledFixture = (): LabeledEvidence[] => assignEvidenceLabels([
  evidence({ chunkId: "chunk-p3", pageNumber: 3, similarity: 0.82 }),
  evidence({ chunkId: "chunk-p7", pageNumber: 7, similarity: 0.71 }),
]);

test("labels are assigned S1..Sn in retrieval rank order", () => {
  const labeled = labeledFixture();
  assert.deepEqual(labeled.map((entry) => entry.label), ["S1", "S2"]);
  assert.equal(labeled[0].evidence.chunkId, "chunk-p3");
});

test("model can only reference labels; it cannot alter filename or page", () => {
  // model claims it used S2 (and even writes a wrong page in prose)
  const citations = buildCitations(labeledFixture(), ["S2"]);
  assert.equal(citations.length, 1);
  assert.deepEqual(citations[0], { citationId: "c1", documentId: "doc-1", chunkId: "chunk-p7", filename: "lecture.pdf", pageNumber: 7 });
});

test("unknown labels (S99) never produce a citation", () => {
  assert.deepEqual(buildCitations(labeledFixture(), ["S99", "S3", "banana", "S-1", "s0x"]), []);
});

test("missing / empty label lists produce no citations", () => {
  assert.deepEqual(buildCitations(labeledFixture(), []), []);
  assert.deepEqual(buildCitations(labeledFixture(), [undefined as unknown as string, "", "   "]), []);
});

test("malformed label tokens are rejected, valid ones still map", () => {
  const citations = buildCitations(labeledFixture(), ["[S2]", " s2 ", "S2extra", "S 2", "SII"]);
  assert.equal(citations.length, 1);
  assert.equal(citations[0].pageNumber, 7);
});

test("duplicate labels are de-duplicated deterministically", () => {
  const citations = buildCitations(labeledFixture(), ["S1", "s1", "[S1]", "S1"]);
  assert.equal(citations.length, 1);
  assert.equal(citations[0].chunkId, "chunk-p3");
});

test("multiple valid citations are returned in retrieval-rank order regardless of mention order", () => {
  const citations = buildCitations(labeledFixture(), ["S2", "S1"]);
  assert.deepEqual(citations.map((c) => c.chunkId), ["chunk-p3", "chunk-p7"]);
  assert.deepEqual(citations.map((c) => c.citationId), ["c1", "c2"]);
});

test("two labels pointing at the same chunk collapse to one citation", () => {
  const labeled = assignEvidenceLabels([
    evidence({ chunkId: "same", pageNumber: 4 }),
    evidence({ chunkId: "same", pageNumber: 4 }),
  ]);
  assert.equal(buildCitations(labeled, ["S1", "S2"]).length, 1);
});

test("extractSourceLabels pulls [S#] tokens from generated prose", () => {
  assert.deepEqual(extractSourceLabels("As shown [S1], and also [ s3 ] plus [S1] again."), ["S1", "S3"]);
  assert.deepEqual(extractSourceLabels("no labels here"), []);
  assert.deepEqual(extractSourceLabels(123 as unknown as string), []);
});

test("normaliseUsedSources cleans and validates raw model arrays", () => {
  assert.deepEqual(normaliseUsedSources(["S1", "[S2]", " s3 ", "S1", "nope", 5, "S 4"]), ["S1", "S2", "S3"]);
  assert.deepEqual(normaliseUsedSources("S1"), []);
  assert.deepEqual(normaliseUsedSources(undefined), []);
});
