import "server-only";
import type { ExamMarks, ExplanationMode } from "@/types/chat";
import type { GroundedAnswer, RagGenerationOutput, RagRequest } from "@/types/rag";
import type { RetrievalMatch } from "@/lib/documents/retrieval";
import { retrieveDocumentChunks } from "@/lib/documents/retrieval";
import { generateGroundedCompletion, RagGenerationError } from "@/lib/documents/rag-generation";
import { buildRagPrompt, type RagPrompt, type PersonalizationPromptInput } from "@/lib/documents/rag-prompt";
import { assignEvidenceLabels, buildCitations, extractSourceLabels, normaliseUsedSources } from "@/lib/documents/citations";

export class RagRequestError extends Error {}

const VALID_MODES: ExplanationMode[] = ["simple", "detailed", "exam"];
const VALID_MARKS: ExamMarks[] = [2, 5, 10, 16];

// Deterministic refusal used whenever retrieval is insufficient — no model call happens.
export const INSUFFICIENT_EVIDENCE_MESSAGE =
  "I couldn't find enough information in the selected document(s) to answer that reliably. Try rephrasing your question, or select material that covers this topic.";
const GENERATION_FAILED_MESSAGE = "I couldn't generate a grounded answer just now. Please try again in a moment.";

// Upper bound on retrieved source characters sent to the model. Phase 2 Top-K is
// already bounded; this is a second guard. Whole evidence blocks are dropped from
// the lowest rank so citation labels are never sliced.
const EVIDENCE_CHAR_BUDGET = 12_000;

/** Keeps the highest-ranked evidence blocks whole until the character budget would be exceeded. */
export function applyEvidenceBudget<T extends { text: string }>(evidence: T[], budget = EVIDENCE_CHAR_BUDGET): T[] {
  const kept: T[] = [];
  let used = 0;
  for (const item of evidence) {
    const size = typeof item.text === "string" ? item.text.length : 0;
    if (kept.length > 0 && used + size > budget) break; // always keep at least the top-ranked block
    kept.push(item);
    used += size;
  }
  return kept;
}

function tryParseJsonObject(candidate: string): RagGenerationOutput | null {
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.answer !== "string") return null;
    return { answer: record.answer, usedSources: Array.isArray(record.usedSources) ? record.usedSources.map(String) : [] };
  } catch {
    return null;
  }
}

/**
 * Tolerant parser for the generation contract. Returns null when the output was
 * clearly an attempt at the JSON contract but is malformed (caller treats that as
 * a safe failure). Plain prose is accepted as the answer with no structured labels.
 */
export function parseGenerationOutput(raw: unknown): RagGenerationOutput | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let text = raw.trim();

  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) text = fenced[1].trim();

  const direct = tryParseJsonObject(text);
  if (direct) return direct;

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const embedded = tryParseJsonObject(text.slice(start, end + 1));
    if (embedded) return embedded;
  }

  // No valid JSON object recovered. If it looked like JSON, it is malformed.
  if (/^[\s\n]*[[{]/.test(raw) || /"answer"\s*:/.test(raw)) return null;

  // Otherwise treat the plain text as the answer; labels (if any) are scraped later.
  return { answer: raw.trim(), usedSources: [] };
}

export interface RagDependencies {
  retrieve?: (question: string, documentIds: string[]) => Promise<{ status: "sufficient" | "insufficient"; matches: RetrievalMatch[] }>;
  generate?: (prompt: RagPrompt) => Promise<string>;
  // ARCHITECTURE.md §21's ONE new optional dependency, Phase 10 -- "answerWithRag() keeps
  // its Revision-1 signature (one new optional dependency: a learner-context fetch)." Deliberately
  // a function, not an inline value: it is only ever called AFTER retrieval is confirmed
  // sufficient (Step 9 -- "if retrieval is insufficient... no pedagogical/personalization content
  // is even computed for that turn"), and never on the insufficient-evidence path below. A
  // rejection here is swallowed, never allowed to fail the whole request (Step 28) -- normal
  // grounded RAG must survive a personalization failure.
  fetchPersonalization?: () => Promise<PersonalizationPromptInput | undefined>;
}

function validate(request: RagRequest): { question: string; documentIds: string[]; mode: ExplanationMode; marks?: ExamMarks } {
  const question = typeof request.question === "string" ? request.question.trim() : "";
  if (!question) throw new RagRequestError("Enter a question before asking about your documents.");
  if (question.length > 10_000) throw new RagRequestError("Your question is too long. Please shorten it.");
  if (!Array.isArray(request.documentIds) || request.documentIds.length === 0 || !request.documentIds.every((id) => typeof id === "string" && id.trim())) {
    throw new RagRequestError("Select at least one ready document.");
  }
  if (!VALID_MODES.includes(request.mode)) throw new RagRequestError("Choose a valid answer mode.");
  if (request.marks !== undefined && !VALID_MARKS.includes(request.marks)) throw new RagRequestError("Choose a valid mark value.");
  return { question, documentIds: [...new Set(request.documentIds)], mode: request.mode, marks: request.mode === "exam" ? request.marks : undefined };
}

/**
 * Grounded RAG pipeline: validate -> retrieve -> (refuse if insufficient) -> label ->
 * budget -> prompt -> generate -> parse/validate -> authoritative citations.
 * The generation layer never searches documents; retrieval is the only evidence source.
 */
export async function answerWithRag(request: RagRequest, dependencies: RagDependencies = {}): Promise<GroundedAnswer> {
  const retrieve = dependencies.retrieve ?? ((question, documentIds) => retrieveDocumentChunks(question, documentIds));
  const generate = dependencies.generate ?? generateGroundedCompletion;

  const { question, documentIds, mode, marks } = validate(request);

  let retrieval: Awaited<ReturnType<typeof retrieve>>;
  try {
    retrieval = await retrieve(question, documentIds);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    // Infrastructure failure from the retrieval layer: stay generic, never leak DB internals.
    if (/semantic retrieval failed/i.test(message)) throw new RagGenerationError("Retrieval is temporarily unavailable. Please try again.");
    // Otherwise the caller's selection/question was invalid (e.g. a document is not ready).
    throw new RagRequestError(message || "Your document selection could not be used.");
  }
  if (!retrieval || retrieval.status !== "sufficient" || !Array.isArray(retrieval.matches) || retrieval.matches.length === 0) {
    return { status: "insufficient", answer: INSUFFICIENT_EVIDENCE_MESSAGE, citations: [], evidence: [] };
  }

  const budgeted = applyEvidenceBudget(retrieval.matches);
  const labeled = assignEvidenceLabels(budgeted);

  // Only ever reached once retrieval is confirmed sufficient (§21/Step 9) -- an insufficient turn
  // never computes personalization at all, matching the insufficient-evidence return above, which
  // already happened before this line if it applied.
  const personalization = dependencies.fetchPersonalization ? await dependencies.fetchPersonalization().catch(() => undefined) : undefined;

  const prompt = buildRagPrompt({
    question,
    mode,
    marks,
    history: request.history,
    labeledEvidence: labeled,
    personalization,
  });

  let raw: string;
  try {
    raw = await generate(prompt);
  } catch {
    throw new RagGenerationError(GENERATION_FAILED_MESSAGE);
  }

  const parsed = parseGenerationOutput(raw);
  if (!parsed || !parsed.answer.trim()) {
    throw new RagGenerationError(GENERATION_FAILED_MESSAGE);
  }

  const referencedLabels = [...normaliseUsedSources(parsed.usedSources), ...extractSourceLabels(parsed.answer)];
  const citations = buildCitations(labeled, referencedLabels);

  return {
    status: "grounded",
    answer: parsed.answer.trim(),
    citations,
    evidence: labeled.map((entry) => ({
      label: entry.label,
      chunkId: entry.evidence.chunkId,
      documentId: entry.evidence.documentId,
      filename: entry.evidence.filename,
      pageNumber: entry.evidence.pageNumber,
    })),
  };
}

export { RagGenerationError };
