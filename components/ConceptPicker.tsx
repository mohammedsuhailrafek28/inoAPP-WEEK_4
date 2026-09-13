"use client";

import React, { useEffect, useState } from "react";
import type { ConceptSummary } from "@/types/progress";

interface ConceptPickerProps {
  value: string | null;
  onChange: (conceptKey: string | null) => void;
  disabled?: boolean;
}

// Step 5's personalization entry point for chat: an OPTIONAL, explicit concept the student is
// focusing on. Never inferred from the question text, never authoritative for anything beyond
// "which concept to personalize around" (ARCHITECTURE.md §21/§22, Phase 10) -- every actual
// learner-state value stays entirely server-derived.
export default function ConceptPicker({ value, onChange, disabled = false }: ConceptPickerProps) {
  const [concepts, setConcepts] = useState<ConceptSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/learning/concepts");
        const data = (await response.json()) as { concepts?: ConceptSummary[] };
        if (!cancelled && Array.isArray(data.concepts)) setConcepts(data.concepts);
      } catch {
        /* the chat itself works perfectly well with zero personalization if this fails */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (concepts.length === 0) return null;

  return (
    <label className="flex items-center gap-2">
      <span className="hidden text-[10px] font-medium uppercase tracking-[0.16em] text-muted/70 sm:inline">Focus</span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        disabled={disabled}
        aria-label="Personalize teaching around a concept"
        className="rounded-md border border-line bg-elevated-2 px-2 py-1 text-[11px] text-ink outline-none transition-colors focus:border-accent/55 disabled:opacity-50"
      >
        <option value="">General</option>
        {concepts.map((c) => (
          <option key={c.id} value={c.conceptKey}>
            {c.displayName}
          </option>
        ))}
      </select>
    </label>
  );
}
