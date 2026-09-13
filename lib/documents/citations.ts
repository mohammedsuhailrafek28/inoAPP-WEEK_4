import type { Citation, LabeledEvidence } from "@/types/rag";

// A valid evidence label is exactly "S" followed by one or more digits: S1, S2, S12.
const LABEL_PATTERN = /^S\d+$/;
// Finds label references inside generated text, e.g. "... as shown in [S2]." or "[S1][S3]".
const INLINE_LABEL_PATTERN = /\[\s*(S\d+)\s*\]/gi;

/**
 * Assigns stable, server-owned labels (S1, S2, ...) to retrieved evidence in
 * rank order. The returned mapping is the ONLY bridge between a model reference
 * and real document metadata.
 */
export function assignEvidenceLabels(evidence: LabeledEvidence["evidence"][]): LabeledEvidence[] {
  return evidence.map((item, index) => ({ label: `S${index + 1}`, evidence: item }));
}

/** Extracts `[S#]` label tokens from arbitrary generated text, upper-cased and de-duplicated in first-seen order. */
export function extractSourceLabels(text: string): string[] {
  if (typeof text !== "string") return [];
  const found: string[] = [];
  for (const match of text.matchAll(INLINE_LABEL_PATTERN)) {
    const label = match[1].toUpperCase();
    if (!found.includes(label)) found.push(label);
  }
  return found;
}

/** Normalises a raw `usedSources` value from model output into clean candidate labels. */
export function normaliseUsedSources(usedSources: unknown): string[] {
  if (!Array.isArray(usedSources)) return [];
  const result: string[] = [];
  for (const raw of usedSources) {
    if (typeof raw !== "string") continue;
    // Accept "S1" or "[S1]" or " s1 "; reject everything else.
    const cleaned = raw.trim().replace(/^\[\s*/, "").replace(/\s*\]$/, "").toUpperCase();
    if (LABEL_PATTERN.test(cleaned) && !result.includes(cleaned)) result.push(cleaned);
  }
  return result;
}

/**
 * Builds authoritative citations from retrieved evidence and the labels a model
 * claims to have used. Policy:
 *  - Only labels that exist in `labeled` produce a citation.
 *  - Unknown / malformed labels (e.g. "S99", "banana", "S-1") are ignored.
 *  - Every citation field is copied from server-owned metadata, never generated text.
 *  - Citations are de-duplicated by chunkId, preserving retrieval rank order.
 *  - `citationId` is deterministic and stable (`c<n>` in final ordering).
 */
export function buildCitations(labeled: LabeledEvidence[], referencedLabels: string[]): Citation[] {
  const byLabel = new Map(labeled.map((entry) => [entry.label.toUpperCase(), entry]));
  const seenChunks = new Set<string>();
  const ordered: LabeledEvidence[] = [];

  for (const raw of referencedLabels) {
    if (typeof raw !== "string") continue;
    const label = raw.trim().replace(/^\[\s*/, "").replace(/\s*\]$/, "").toUpperCase();
    if (!LABEL_PATTERN.test(label)) continue;
    const entry = byLabel.get(label);
    if (!entry) continue; // unknown label -> no fabricated citation
    if (seenChunks.has(entry.evidence.chunkId)) continue; // duplicate -> collapse
    seenChunks.add(entry.evidence.chunkId);
    ordered.push(entry);
  }

  // Deterministic final ordering: by original retrieval rank (label index), not model mention order.
  ordered.sort((a, b) => labeled.indexOf(a) - labeled.indexOf(b));

  return ordered.map((entry, index) => ({
    citationId: `c${index + 1}`,
    documentId: entry.evidence.documentId,
    chunkId: entry.evidence.chunkId,
    filename: entry.evidence.filename,
    pageNumber: entry.evidence.pageNumber,
  }));
}
