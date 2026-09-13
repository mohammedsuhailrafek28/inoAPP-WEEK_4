import assert from "node:assert/strict";
import test from "node:test";
import { ingestPdf } from "@/lib/documents/ingestion";
import { EmbeddingError } from "@/lib/documents/embeddings";

const DIMENSIONS = 768;
const goodVector = () => Array.from({ length: DIMENSIONS }, () => 0.01);
const shortVector = () => Array.from({ length: DIMENSIONS - 1 }, () => 0.01);

const validatedPdf = () => ({
  id: "doc-ingest-1",
  bytes: new Uint8Array([1, 2, 3, 4, 5]),
  originalFilename: "lecture.pdf",
  displayName: "lecture.pdf",
  contentHash: "hash",
  storagePath: "single-user/doc-ingest-1/original.pdf",
});

const threePages = () => ({
  pageCount: 3,
  pages: [
    { pageNumber: 1, text: "Photosynthesis converts light energy into chemical energy stored in glucose molecules." },
    { pageNumber: 2, text: "Cellular respiration releases the energy held in glucose to synthesise ATP for the cell." },
    { pageNumber: 3, text: "Mitochondria are the organelles where most aerobic ATP production takes place in eukaryotes." },
  ],
});

// Deterministic in-memory stand-in for the Supabase admin client. Records document status transitions and
// per-chunk embedding writes so tests can assert on the persisted state. `vectorMode` models the Postgres
// `vector(768)` column: "strict" rejects a malformed vector with an error, "permissive" lets the write
// "succeed" without persisting anything (so the ready-state completeness check is what must catch it).
function fakeIngestionSupabase(options: { vectorMode?: "strict" | "permissive" } = {}) {
  const vectorMode = options.vectorMode ?? "strict";
  const doc: Record<string, unknown> = {};
  const chunkRows: Array<Record<string, unknown>> = [];
  const chunkEmbeddings = new Map<string, unknown>();
  const calls: string[] = [];
  const statusHistory: string[] = [];
  let countQueried = false;

  const record = (row: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(row)) {
      if (value === undefined) continue;
      doc[key] = value;
      if (key === "status") statusHistory.push(String(value));
    }
  };
  const isValidVector = (value: unknown) =>
    Array.isArray(value) && value.length === DIMENSIONS && value.every((n) => typeof n === "number" && Number.isFinite(n));

  function documentsBuilder() {
    const builder: Record<string, unknown> = {};
    Object.assign(builder, {
      insert(row: Record<string, unknown>) { calls.push("documents.insert"); record(row); return Promise.resolve({ error: null }); },
      update(payload: Record<string, unknown>) { calls.push("documents.update"); record(payload); return builder; },
      select() { return builder; },
      eq() { return builder; },
      order() { return Promise.resolve({ data: [{ ...doc }], error: null }); },
      single() { return Promise.resolve({ data: { ...doc }, error: null }); },
      then(onFulfilled: (value: unknown) => unknown) { return Promise.resolve({ data: [{ ...doc }], error: null }).then(onFulfilled); },
    });
    return builder;
  }

  function chunksBuilder() {
    let pendingUpdate: Record<string, unknown> | null = null;
    let targetId: string | null = null;
    let countMode = false;
    const builder: Record<string, unknown> = {};
    Object.assign(builder, {
      insert(rows: Array<Record<string, unknown>>) {
        calls.push("chunks.insert");
        for (const row of rows) { chunkRows.push(row); chunkEmbeddings.set(String(row.id), null); }
        return Promise.resolve({ error: null });
      },
      update(payload: Record<string, unknown>) { calls.push("chunks.update"); pendingUpdate = payload; return builder; },
      delete() { calls.push("chunks.delete"); chunkRows.length = 0; chunkEmbeddings.clear(); return builder; },
      select(_columns?: unknown, opts?: { count?: string; head?: boolean }) { if (opts?.count) countMode = true; return builder; },
      eq(column: string, value: string) { if (column === "id") targetId = value; return builder; },
      not() { return builder; },
      then(onFulfilled: (value: unknown) => unknown) {
        if (pendingUpdate && "embedding" in pendingUpdate && targetId) {
          const vector = pendingUpdate.embedding;
          if (isValidVector(vector)) { chunkEmbeddings.set(targetId, vector); return Promise.resolve({ error: null }).then(onFulfilled); }
          if (vectorMode === "strict") return Promise.resolve({ error: { message: "invalid input syntax for type vector(768)" } }).then(onFulfilled);
          return Promise.resolve({ error: null }).then(onFulfilled);
        }
        if (countMode) {
          countQueried = true;
          const count = [...chunkEmbeddings.values()].filter((value) => value !== null).length;
          return Promise.resolve({ count, error: null }).then(onFulfilled);
        }
        return Promise.resolve({ error: null }).then(onFulfilled);
      },
    });
    return builder;
  }

  const client = { from: (table: string) => (table === "documents" ? documentsBuilder() : chunksBuilder()) };
  return {
    client: client as never,
    state: { doc, chunkRows, chunkEmbeddings, calls, statusHistory },
    get countQueried() { return countQueried; },
  };
}

const baseDeps = (supabase: ReturnType<typeof fakeIngestionSupabase>) => ({
  supabase: supabase.client,
  storePdf: async () => {},
  removePdf: async () => {},
  extractPages: async () => threePages(),
});

test("control: ingestion reaches ready only when every chunk gets a valid vector", async () => {
  const supabase = fakeIngestionSupabase();
  const result = await ingestPdf(validatedPdf(), { ...baseDeps(supabase), embedChunks: async (texts) => texts.map(() => goodVector()) });
  assert.equal(result.status, "ready");
  assert.equal(result.chunkCount, 3);
  assert.equal([...supabase.state.chunkEmbeddings.values()].filter((value) => value !== null).length, 3);
});

test("ingestion embedding failure never marks the document ready and persists a truthful failed state", async () => {
  const supabase = fakeIngestionSupabase();
  const result = await ingestPdf(validatedPdf(), {
    ...baseDeps(supabase),
    embedChunks: async () => { throw new EmbeddingError("Embedding request failed."); },
  });

  assert.equal(result.status, "failed");
  assert.notEqual(result.status, "ready");
  assert.ok(!supabase.state.statusHistory.includes("ready"), "document must never transition through ready");
  assert.ok(!result.processedAt, "a failed document must not carry a processed_at timestamp");
  assert.ok(!result.embeddingModel, "a failed document must not advertise an embedding model");

  // Failure reason is a safe, user-facing string with no provider/internal detail.
  assert.equal(result.failureReason, "Document processing failed. Please try another text-based PDF.");
  assert.doesNotMatch(String(result.failureReason), /EmbeddingError|api[_ -]?key|GEMINI|stack|token|at Object|\.ts:/i);

  // Existing chunk rows stay intact; nothing was deleted, and no vector was written.
  assert.ok(!supabase.state.calls.includes("chunks.delete"), "persisted chunks must not be dropped on embedding failure");
  assert.equal(supabase.state.chunkRows.length, 3);
  assert.equal([...supabase.state.chunkEmbeddings.values()].filter((value) => value !== null).length, 0);
});

test("a malformed vector for one chunk is rejected at persistence and blocks ready", async () => {
  const supabase = fakeIngestionSupabase({ vectorMode: "strict" });
  const result = await ingestPdf(validatedPdf(), {
    ...baseDeps(supabase),
    embedChunks: async (texts) => texts.map((_, index) => (index === 1 ? shortVector() : goodVector())),
  });

  assert.equal(result.status, "failed");
  assert.ok(!supabase.state.statusHistory.includes("ready"));
  // The invalid vector was never accepted; at least one chunk still has no embedding.
  assert.ok([...supabase.state.chunkEmbeddings.values()].some((value) => value === null));
  assert.doesNotMatch(String(result.failureReason), /vector\(768\)|EmbeddingError|api[_ -]?key|GEMINI/i);
});

test("ready-state completeness check catches an unpersisted chunk vector even when the write reports success", async () => {
  const supabase = fakeIngestionSupabase({ vectorMode: "permissive" });
  const result = await ingestPdf(validatedPdf(), {
    ...baseDeps(supabase),
    // Correct vector COUNT (so the count guard passes) but one entry is malformed and silently not stored.
    embedChunks: async (texts) => texts.map((_, index) => (index === 1 ? shortVector() : goodVector())),
  });

  assert.equal(result.status, "failed");
  assert.ok(!supabase.state.statusHistory.includes("ready"), "completeness check must prevent ready");
  assert.equal(supabase.countQueried, true, "the not-null embedding completeness count must be consulted");
  assert.equal([...supabase.state.chunkEmbeddings.values()].filter((value) => value !== null).length, 2);
});
