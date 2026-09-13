import "server-only";
import { GoogleGenAI } from "@google/genai";
import type { RagPrompt } from "@/lib/documents/rag-prompt";

export class RagGenerationError extends Error {}

// Matches the Week 1 chat model choice so grounded answers read consistently.
const MODEL_ID = "gemini-3.6-flash";
const MAX_ATTEMPTS = 3;

type GenerationClient = {
  models: { generateContent: (request: unknown) => Promise<{ text?: string }> };
};

function makeClient(): GenerationClient {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new RagGenerationError("Answer generation is not configured.");
  return new GoogleGenAI({ apiKey }) as unknown as GenerationClient;
}

function retryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /429|503|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|temporar|network/i.test(message);
}

export interface GenerationDependencies {
  client?: GenerationClient;
  sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Calls Gemini for a grounded completion and returns the raw model text.
 * JSON is requested via responseMimeType; parsing/validation is the caller's job
 * so it can be exercised without a live model. Never throws provider internals.
 */
export async function generateGroundedCompletion(prompt: RagPrompt, dependencies: GenerationDependencies = {}): Promise<string> {
  const client = dependencies.client ?? makeClient();
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const response = await client.models.generateContent({
        model: MODEL_ID,
        contents: prompt.contents,
        config: {
          systemInstruction: prompt.systemInstruction,
          temperature: 0.2,
          topP: 0.9,
          responseMimeType: "application/json",
        },
      });
      const text = response.text;
      if (!text || !text.trim()) throw new RagGenerationError("The model returned an empty response.");
      return text;
    } catch (error) {
      if (retryable(error) && attempt < MAX_ATTEMPTS - 1) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      throw error instanceof RagGenerationError ? error : new RagGenerationError("Answer generation failed.");
    }
  }
  throw new RagGenerationError("Answer generation failed.");
}
