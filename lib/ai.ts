import { GoogleGenAI } from "@google/genai";
import { ChatMessage, ExplanationMode, ExamMarks } from "@/types/chat";
import { getSystemPrompt } from "@/lib/prompts";

const MODEL_ID = "gemini-3.6-flash"; // Updated to supported model

function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not configured. Please add it to your .env.local file."
    );
  }
  return new GoogleGenAI({ apiKey });
}

/**
 * Generates an AI response for the given message and conversation history.
 * Uses the appropriate system prompt based on the explanation mode and optional marks.
 */
export async function generateResponse(
  message: string,
  mode: ExplanationMode,
  history: ChatMessage[],
  marks?: ExamMarks
): Promise<string> {
  const client = getClient();
  const systemPrompt = getSystemPrompt(mode, marks);

  // Build multi-turn conversation contents
  const contents = history.map((msg) => ({
    role: msg.role === "assistant" ? ("model" as const) : ("user" as const),
    parts: [{ text: msg.content }],
  }));

  // Add the current user message
  contents.push({
    role: "user" as const,
    parts: [{ text: message }],
  });

  const maxRetries = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await client.models.generateContent({
        model: MODEL_ID,
        contents,
        config: {
          systemInstruction: systemPrompt,
          temperature: 0.7,
          topP: 0.9,
        },
      });
      const text = response.text;
      if (!text) {
        throw new Error("The AI returned an empty response. Please try again.");
      }
      return text;
    } catch (err: unknown) {
      lastError = err;
      const isRetryable =
        err instanceof Error &&
        (err.message.includes("503") ||
          err.message.includes("429") ||
          err.message.includes("high demand") ||
          err.message.includes("UNAVAILABLE") ||
          err.message.includes("RESOURCE_EXHAUSTED"));

      if (isRetryable && attempt < maxRetries) {
        console.warn(`Gemini API busy (attempt ${attempt}/${maxRetries}), retrying in ${attempt * 1000}ms...`);
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
        continue;
      }
      console.error("Gemini API error:", err);
      throw err;
    }
  }

  throw lastError;
}
