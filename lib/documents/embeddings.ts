import "server-only";
import { GoogleGenAI } from "@google/genai";

export const EMBEDDING_MODEL = "gemini-embedding-001";
export const EMBEDDING_DIMENSIONS = 768;
const BATCH_SIZE = 8;

export class EmbeddingError extends Error {}

function client() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new EmbeddingError("Embedding service is not configured.");
  return new GoogleGenAI({ apiKey });
}

function validateVector(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== EMBEDDING_DIMENSIONS || value.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
    throw new EmbeddingError("Gemini returned an invalid embedding vector.");
  }
  return value;
}

function transient(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /429|503|UNAVAILABLE|temporar|network/i.test(message);
}

type EmbedClient = { models: { embedContent: (request: unknown) => Promise<{ embeddings?: Array<{ values?: unknown }> }> } };
export function createEmbeddingService(dependencies: { client?: EmbedClient; sleep?: (milliseconds: number) => Promise<void> } = {}) {
  const getClient = dependencies.client ? () => dependencies.client! : client;
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  async function embed(texts: string[], taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY") {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await getClient().models.embedContent({
        model: EMBEDDING_MODEL,
        contents: texts.map((text) => ({ role: "user", parts: [{ text }] })),
        config: { taskType, outputDimensionality: EMBEDDING_DIMENSIONS },
      });
      if (!response.embeddings || response.embeddings.length !== texts.length) throw new EmbeddingError("Gemini returned an incomplete embedding batch.");
      return response.embeddings.map((embedding) => validateVector(embedding.values));
    } catch (error) {
      if (!transient(error) || attempt === 2) throw error instanceof EmbeddingError ? error : new EmbeddingError("Embedding request failed.");
      await sleep(500 * (attempt + 1));
    }
  }
    throw new EmbeddingError("Embedding request failed.");
  }
  async function embedDocumentChunks(texts: string[]) {
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += BATCH_SIZE) vectors.push(...await embed(texts.slice(start, start + BATCH_SIZE), "RETRIEVAL_DOCUMENT"));
  return vectors;
  }
  async function embedQuery(question: string) {
  if (!question.trim()) throw new EmbeddingError("Enter a question before retrieving documents.");
    return (await embed([question.trim()], "RETRIEVAL_QUERY"))[0];
  }
  return { embedDocumentChunks, embedQuery };
}

const service = createEmbeddingService();
export const embedDocumentChunks = service.embedDocumentChunks;
export const embedQuery = service.embedQuery;
