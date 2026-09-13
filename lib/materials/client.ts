// Shared Gemini call + tolerant JSON parsing for the materials generators (notes.ts, flashcards.ts).
// Mirrors lib/quiz/generate.ts's own client/retry/parse logic exactly -- factored into one shared
// file only because notes and flashcards need the identical mechanism twice (unlike quiz generation,
// which has just one call site). This introduces no new grounding/retrieval/RAG system: it only
// wraps the Gemini call itself, using the same model and the same retry policy as every other
// generation call site in this app (lib/ai.ts, lib/documents/rag-generation.ts, lib/quiz/generate.ts).

import "server-only";
import { GoogleGenAI } from "@google/genai";

export class MaterialGenerationError extends Error {}

const MODEL_ID = "gemini-3.6-flash";
const MAX_ATTEMPTS = 3;

type GenerationClient = { models: { generateContent: (request: unknown) => Promise<{ text?: string }> } };

function makeClient(): GenerationClient {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new MaterialGenerationError("Material generation is not configured.");
  return new GoogleGenAI({ apiKey }) as unknown as GenerationClient;
}

function retryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /429|503|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|temporar|network/i.test(message);
}

export interface MaterialGeminiContent {
  role: "user";
  parts: Array<{ text: string }>;
}

export interface MaterialPrompt {
  systemInstruction: string;
  contents: MaterialGeminiContent[];
}

export interface MaterialGenerationDependencies {
  client?: GenerationClient;
  sleep?: (milliseconds: number) => Promise<void>;
}

/** Calls Gemini for the raw generation text. Parsing/validation is the caller's job (lib/materials/validate.ts). */
export async function generateMaterialRaw(prompt: MaterialPrompt, dependencies: MaterialGenerationDependencies = {}): Promise<string> {
  const client = dependencies.client ?? makeClient();
  const sleep = dependencies.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const response = await client.models.generateContent({
        model: MODEL_ID,
        contents: prompt.contents,
        config: { systemInstruction: prompt.systemInstruction, temperature: 0.4, topP: 0.9, responseMimeType: "application/json" },
      });
      const text = response.text;
      if (!text || !text.trim()) throw new MaterialGenerationError("The model returned an empty response.");
      return text;
    } catch (error) {
      if (retryable(error) && attempt < MAX_ATTEMPTS - 1) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      throw error instanceof MaterialGenerationError ? error : new MaterialGenerationError("Material generation failed.");
    }
  }
  throw new MaterialGenerationError("Material generation failed.");
}

/** Tolerant JSON parse -- malformed output becomes `null`, handled by validate.ts's MALFORMED_OUTPUT gate, never thrown past this point. */
export function parseGeneratedMaterial(raw: string): unknown {
  let text = raw.trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) text = fenced[1].trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}
