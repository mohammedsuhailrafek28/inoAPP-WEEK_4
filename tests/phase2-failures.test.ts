import assert from "node:assert/strict";
import test from "node:test";
import { createEmbeddingService, EmbeddingError } from "@/lib/documents/embeddings";
import { retrieveDocumentChunks, validateRetrievalRow } from "@/lib/documents/retrieval";

const DIMENSIONS = 768;
const vector = () => Array.from({ length: DIMENSIONS }, () => 0.01);
const withEntry = (index: number, value: unknown) => { const v = vector(); v[index] = value as number; return v; };
const response = (values: unknown) => ({ embeddings: [{ values }] });
const client = (run: (request: unknown) => Promise<unknown>) => ({ models: { embedContent: run } }) as never;
const SAFE_EMBEDDING_ERROR = /invalid embedding vector|incomplete embedding batch|Embedding request failed|Enter a question/;

// ----------------------------------------------------------------------------
// 1. Embedding response validation — no malformed vector may leave the service
// ----------------------------------------------------------------------------

test("rejects every malformed Gemini embedding response before it can be persisted", async () => {
  const malformedValues: unknown[] = [
    undefined,                       // missing values array
    null,
    "not-an-array",
    {},
    [],                              // empty
    Array(DIMENSIONS - 1).fill(0),   // too short
    Array(DIMENSIONS + 1).fill(0),   // too long
    withEntry(10, Number.NaN),       // NaN
    withEntry(20, Infinity),         // +Infinity
    withEntry(30, -Infinity),        // -Infinity
    withEntry(40, "0.1"),            // non-numeric entry
    withEntry(50, null),             // null entry
    withEntry(60, undefined),        // non-finite / hole
  ];

  for (const values of malformedValues) {
    const service = createEmbeddingService({ client: client(async () => response(values)) });
    await assert.rejects(
      () => service.embedDocumentChunks(["safe chunk text"]),
      (error: unknown) => {
        assert.ok(error instanceof EmbeddingError, `expected EmbeddingError for ${JSON.stringify(values)?.slice(0, 40)}`);
        assert.match(error.message, SAFE_EMBEDDING_ERROR);
        return true;
      },
    );
  }
});

test("rejects a batch whose embedding count does not match the request", async () => {
  for (const embeddings of [undefined, [], [{ values: vector() }, { values: vector() }]]) {
    const service = createEmbeddingService({ client: client(async () => ({ embeddings })) });
    await assert.rejects(() => service.embedQuery("one question"), (error: unknown) => {
      assert.ok(error instanceof EmbeddingError);
      assert.match(error.message, SAFE_EMBEDDING_ERROR);
      return true;
    });
  }
});

// ----------------------------------------------------------------------------
// 2. Transient Gemini failure — bounded retry, real backoff path, then success
// ----------------------------------------------------------------------------

test("retries bounded transient failures, exercises increasing backoff, and returns a valid vector", async () => {
  let calls = 0;
  const delays: number[] = [];
  const service = createEmbeddingService({
    client: client(async () => { calls++; if (calls < 3) throw new Error("503 UNAVAILABLE: backend temporarily down"); return response(vector()); }),
    sleep: async (milliseconds) => { delays.push(milliseconds); },
  });

  const result = await service.embedQuery("question");
  assert.equal(result.length, DIMENSIONS);
  assert.equal(calls, 3);                 // 2 failures + 1 success
  assert.deepEqual(delays, [500, 1000]);  // backoff path exercised, monotonically increasing, never actually waited
});

test("gives up after a bounded number of transient failures instead of looping forever", async () => {
  let calls = 0;
  const delays: number[] = [];
  const service = createEmbeddingService({
    client: client(async () => { calls++; throw new Error("network error"); }),
    sleep: async (milliseconds) => { delays.push(milliseconds); },
  });

  await assert.rejects(() => service.embedQuery("question"), EmbeddingError);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [500, 1000]);
});

// ----------------------------------------------------------------------------
// 3. Permanent Gemini failure — no retries, safe surface, no secret leakage
// ----------------------------------------------------------------------------

test("does not retry permanent failures and never leaks API key or provider internals", async () => {
  for (const raw of [
    "401 Unauthorized: API key AIzaSyFAKE-LEAKED-KEY-1234 is invalid",
    "INVALID_ARGUMENT: request payload malformed",
    "PERMISSION_DENIED: caller does not have permission",
  ]) {
    let calls = 0;
    const service = createEmbeddingService({
      client: client(async () => { calls++; throw new Error(raw); }),
      sleep: async () => assert.fail("permanent failures must not back off"),
    });

    await assert.rejects(() => service.embedQuery("question"), (error: unknown) => {
      assert.ok(error instanceof EmbeddingError);
      assert.equal(error.message, "Embedding request failed.");
      assert.doesNotMatch(error.message, /AIzaSy|LEAKED|Unauthorized|API key|INVALID_ARGUMENT|PERMISSION_DENIED/i);
      return true;
    });
    assert.equal(calls, 1);
  }
});

// ----------------------------------------------------------------------------
// 4. Quota / resource exhaustion — matches current classification policy
// ----------------------------------------------------------------------------

test("bare RESOURCE_EXHAUSTED is classified as permanent and is not retried", async () => {
  let calls = 0;
  const service = createEmbeddingService({
    client: client(async () => { calls++; throw new Error("RESOURCE_EXHAUSTED: embed content quota exhausted"); }),
    sleep: async () => assert.fail("quota exhaustion must not trigger backoff in the current policy"),
  });

  await assert.rejects(() => service.embedQuery("question"), EmbeddingError);
  assert.equal(calls, 1);
});

test("a 429 quota response is retried but stays strictly bounded (no uncontrolled loop)", async () => {
  let calls = 0;
  const delays: number[] = [];
  const service = createEmbeddingService({
    client: client(async () => { calls++; throw new Error("429 Too Many Requests: RESOURCE_EXHAUSTED quota"); }),
    sleep: async (milliseconds) => { delays.push(milliseconds); },
  });

  await assert.rejects(() => service.embedQuery("question"), (error: unknown) => {
    assert.ok(error instanceof EmbeddingError);
    assert.equal(error.message, "Embedding request failed.");
    return true;
  });
  assert.equal(calls, 3);                 // bounded by the same 3-attempt ceiling
  assert.deepEqual(delays, [500, 1000]);
});

// ----------------------------------------------------------------------------
// Retrieval failure paths
// ----------------------------------------------------------------------------

function retrievalSupabase(config: { documents?: Array<{ id: string; status: string }>; rpc?: { data?: unknown[]; error?: unknown } } = {}) {
  const documents = config.documents ?? [{ id: "doc-1", status: "ready" }];
  const rpc = config.rpc ?? { data: [] };
  return {
    from: () => ({
      select: () => ({
        in: async (_column: string, ids: string[]) => ({ data: documents.filter((document) => ids.includes(document.id)), error: null }),
      }),
    }),
    rpc: async () => rpc,
  } as never;
}
const countingEmbed = () => { const state = { calls: 0 }; return { state, embed: async () => { state.calls++; return vector(); } }; };
const validRow = () => ({ chunk_id: "c1", document_id: "doc-1", filename: "lecture.pdf", page_number: 3, ordinal_on_page: 2, text: "evidence text", similarity: 0.72 });

// ----------------------------------------------------------------------------
// 7. Retrieval RPC failure — no invented matches, safe error, no leakage
// ----------------------------------------------------------------------------

test("surfaces a safe error on RPC failure and never fabricates fallback matches", async () => {
  const { state, embed } = countingEmbed();
  await assert.rejects(
    () => retrieveDocumentChunks("question", ["doc-1"], 5, 0.55, {
      supabase: retrievalSupabase({ rpc: { error: { message: "connection to 10.0.0.5:5432 failed; secret=pg_SECRET_TOKEN" } } }),
      embed,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Semantic retrieval failed.");
      assert.doesNotMatch(error.message, /10\.0\.0\.5|SECRET|secret=|5432/i);
      return true;
    },
  );
  assert.equal(state.calls, 1); // embedding happened, but no fake evidence was returned
});

// ----------------------------------------------------------------------------
// 8. Document validation — rejected before any downstream embedding work
// ----------------------------------------------------------------------------

test("rejects invalid questions and document selections before the query embedding API is called", async () => {
  const { state, embed } = countingEmbed();
  const ready = retrievalSupabase();

  await assert.rejects(() => retrieveDocumentChunks("", ["doc-1"], 5, 0.55, { supabase: ready, embed }), /question/i);
  await assert.rejects(() => retrieveDocumentChunks("   \n\t ", ["doc-1"], 5, 0.55, { supabase: ready, embed }), /question/i);
  await assert.rejects(() => retrieveDocumentChunks("valid question", [], 5, 0.55, { supabase: ready, embed }), /ready document/i);
  await assert.rejects(() => retrieveDocumentChunks("valid question", null as unknown as string[], 5, 0.55, { supabase: ready, embed }), /ready document/i);
  await assert.rejects(
    () => retrieveDocumentChunks("valid question", ["ghost-doc"], 5, 0.55, { supabase: retrievalSupabase(), embed }),
    /exist and be ready/i,
  );
  await assert.rejects(
    () => retrieveDocumentChunks("valid question", ["doc-1"], 5, 0.55, { supabase: retrievalSupabase({ documents: [{ id: "doc-1", status: "embedding" }] }), embed }),
    /exist and be ready/i,
  );
  await assert.rejects(
    () => retrieveDocumentChunks("valid question", ["doc-1", "doc-2"], 5, 0.55, {
      supabase: retrievalSupabase({ documents: [{ id: "doc-1", status: "ready" }, { id: "doc-2", status: "failed" }] }),
      embed,
    }),
    /exist and be ready/i,
  );

  assert.equal(state.calls, 0);
});

// ----------------------------------------------------------------------------
// 9. Retrieval result validation — invalid rows never become evidence
// ----------------------------------------------------------------------------

test("validateRetrievalRow authoritatively rejects every malformed field", () => {
  const invalidByField: Array<[string, unknown]> = [
    ["chunk_id", 123], ["chunk_id", undefined], ["chunk_id", null],
    ["document_id", 5], ["document_id", undefined],
    ["filename", 42], ["filename", null],
    ["page_number", 1.5], ["page_number", 0], ["page_number", -2], ["page_number", "3"], ["page_number", Number.NaN],
    ["ordinal_on_page", 0], ["ordinal_on_page", 2.5], ["ordinal_on_page", "1"],
    ["text", 7], ["text", undefined], ["text", null],
    ["similarity", Number.NaN], ["similarity", Infinity], ["similarity", -Infinity], ["similarity", "0.7"], ["similarity", null],
  ];
  for (const [field, badValue] of invalidByField) {
    assert.equal(validateRetrievalRow({ ...validRow(), [field]: badValue }), null, `${field}=${String(badValue)} must be rejected`);
  }
  assert.equal(validateRetrievalRow(null), null);
  assert.equal(validateRetrievalRow("row"), null);
  assert.equal(validateRetrievalRow(undefined), null);

  assert.deepEqual(validateRetrievalRow(validRow()), {
    chunkId: "c1", documentId: "doc-1", filename: "lecture.pdf", pageNumber: 3, ordinalOnPage: 2, text: "evidence text", similarity: 0.72,
  });
});

test("retrieval discards malformed RPC rows and never reports a falsely sufficient status", async () => {
  const { embed } = countingEmbed();
  const mixed = await retrieveDocumentChunks("question", ["doc-1"], 5, 0.55, {
    supabase: retrievalSupabase({ rpc: { data: [validRow(), { ...validRow(), similarity: Number.NaN }, { chunk_id: "partial-row-only" }] } }),
    embed,
  });
  assert.equal(mixed.matches.length, 1);
  assert.equal(mixed.status, "sufficient");
  assert.equal(mixed.matches[0].chunkId, "c1");

  const allInvalid = await retrieveDocumentChunks("question", ["doc-1"], 5, 0.55, {
    supabase: retrievalSupabase({ rpc: { data: [{ chunk_id: "x" }, { ...validRow(), page_number: 0 }, { ...validRow(), similarity: Infinity }] } }),
    embed,
  });
  assert.deepEqual(allInvalid, { status: "insufficient", matches: [] });

  const empty = await retrieveDocumentChunks("question", ["doc-1"], 5, 0.55, { supabase: retrievalSupabase({ rpc: { data: [] } }), embed });
  assert.deepEqual(empty, { status: "insufficient", matches: [] });
});
