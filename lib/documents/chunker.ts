import { createHash } from "node:crypto";
import type { DocumentChunk, ExtractedPage } from "@/types/documents";

const TARGET_TOKENS = 800;
const OVERLAP_TOKENS = 120;
// Approximation only: token count is based on words/punctuation, not a Gemini tokenizer.
const TOKEN_PATTERN = /\S+/g;

function estimatedTokens(text: string) { return text.match(TOKEN_PATTERN)?.length ?? 0; }
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function sentences(text: string) { return text.match(/[^.!?]+(?:[.!?]+|$)/g)?.map((part) => part.trim()).filter(Boolean) ?? [text]; }

function splitOversized(text: string): string[] {
  const words = text.match(TOKEN_PATTERN) ?? [];
  const result: string[] = [];
  for (let start = 0; start < words.length; start += TARGET_TOKENS - OVERLAP_TOKENS) {
    result.push(words.slice(start, start + TARGET_TOKENS).join(" "));
    if (start + TARGET_TOKENS >= words.length) break;
  }
  return result;
}

function pageSegments(text: string): string[] {
  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const result: string[] = [];
  for (const paragraph of paragraphs.length ? paragraphs : [text]) {
    if (estimatedTokens(paragraph) <= TARGET_TOKENS) result.push(paragraph);
    else for (const sentence of sentences(paragraph)) {
      if (estimatedTokens(sentence) <= TARGET_TOKENS) result.push(sentence);
      else result.push(...splitOversized(sentence));
    }
  }
  return result;
}

export function createPageScopedChunks(documentId: string, pages: ExtractedPage[], createdAt = new Date().toISOString()): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  for (const page of pages) {
    const segments = pageSegments(page.text);
    let current: string[] = [];
    let currentTokens = 0;
    const emit = () => {
      const text = current.join("\n\n").trim();
      if (!text) return;
      const contentHash = hash(text);
      const ordinalOnPage = chunks.filter((chunk) => chunk.pageNumber === page.pageNumber).length + 1;
      chunks.push({ id: `chunk_${documentId}_p${page.pageNumber}_${ordinalOnPage}_${contentHash.slice(0, 12)}`, documentId, pageNumber: page.pageNumber, ordinalOnPage, text, tokenCount: estimatedTokens(text), contentHash, createdAt });
    };
    for (const segment of segments) {
      const segmentTokens = estimatedTokens(segment);
      if (currentTokens && currentTokens + segmentTokens > TARGET_TOKENS) {
        const overlapWords = current.join(" ").match(TOKEN_PATTERN) ?? [];
        emit();
        current = overlapWords.slice(-OVERLAP_TOKENS).join(" ") ? [overlapWords.slice(-OVERLAP_TOKENS).join(" ")] : [];
        currentTokens = estimatedTokens(current.join(" "));
      }
      current.push(segment);
      currentTokens += segmentTokens;
    }
    emit();
  }
  return chunks;
}
