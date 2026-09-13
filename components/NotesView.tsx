"use client";

import React, { useEffect, useState } from "react";
import type { GeneratedNotes, NotesGenerationResult } from "@/types/materials";

interface NotesViewProps {
  conceptKey: string;
  conceptDisplayName: string;
  documentIds: string[];
  onBack: () => void;
}

type Phase = "loading" | "ready" | "insufficient" | "no-documents" | "failed";

export default function NotesView({ conceptKey, conceptDisplayName, documentIds, onBack }: NotesViewProps) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [notes, setNotes] = useState<GeneratedNotes | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const load = async () => {
    if (documentIds.length === 0) {
      setPhase("no-documents");
      return;
    }
    setPhase("loading");
    setErrorMessage(null);
    try {
      const response = await fetch("/api/materials/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conceptKey, documentIds }),
      });
      const data = (await response.json()) as NotesGenerationResult | { error: string };
      if ("status" in data) {
        if (data.status === "generated") {
          setNotes(data.notes);
          setPhase("ready");
        } else if (data.status === "insufficient_evidence") {
          setPhase("insufficient");
        } else {
          setErrorMessage(data.reason);
          setPhase("failed");
        }
      } else {
        setErrorMessage(data.error ?? "Could not generate notes.");
        setPhase("failed");
      }
    } catch {
      setErrorMessage("A network error stopped this from loading.");
      setPhase("failed");
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conceptKey, documentIds.join(",")]);

  return (
    <div className="flex flex-col gap-5">
      <button
        type="button"
        onClick={onBack}
        className="self-start text-[11px] font-medium uppercase tracking-[0.16em] text-muted underline decoration-line-strong underline-offset-4 hover:text-ink hover:decoration-accent"
      >
        ← Back to plan
      </button>

      {phase === "loading" && <p className="text-[13px] text-muted">Writing notes on {conceptDisplayName}…</p>}

      {phase === "no-documents" && <p className="text-[13px] leading-relaxed text-muted">Select one or more ready documents in the workspace first — notes are grounded in your own material.</p>}

      {phase === "insufficient" && (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] leading-relaxed text-muted">There isn&rsquo;t enough material in your selected documents to ground notes on {conceptDisplayName} yet.</p>
          <button type="button" onClick={() => void load()} className="self-start text-[11px] font-medium uppercase tracking-[0.16em] text-ink underline decoration-line-strong underline-offset-4 hover:decoration-accent">
            Try again
          </button>
        </div>
      )}

      {phase === "failed" && (
        <div className="flex flex-col gap-3">
          <p role="alert" className="text-[13px] leading-relaxed text-[#e9a991]">
            {errorMessage ?? "Something went wrong generating these notes."}
          </p>
          <button type="button" onClick={() => void load()} className="self-start text-[11px] font-medium uppercase tracking-[0.16em] text-ink underline decoration-line-strong underline-offset-4 hover:decoration-accent">
            Try again
          </button>
        </div>
      )}

      {phase === "ready" && notes && (
        <div className="flex flex-col gap-6">
          <div>
            <h3 className="text-[15px] font-medium text-ink">{notes.title}</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-ink/85">{notes.summary}</p>
          </div>

          {notes.keyPoints.length > 0 && (
            <div>
              <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted/60">Key points</p>
              <ul className="mt-2 flex flex-col gap-1.5">
                {notes.keyPoints.map((point, i) => (
                  <li key={i} className="flex gap-2 text-[13px] leading-relaxed text-ink/85">
                    <span aria-hidden className="text-accent-dim">•</span>
                    {point}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {notes.importantTerms.length > 0 && (
            <div>
              <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted/60">Important terms</p>
              <dl className="mt-2 flex flex-col gap-2.5">
                {notes.importantTerms.map((term, i) => (
                  <div key={i}>
                    <dt className="text-[13px] font-medium text-ink/90">{term.term}</dt>
                    <dd className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{term.definition}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {notes.examFocus.length > 0 && (
            <div>
              <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted/60">Likely to be tested</p>
              <ul className="mt-2 flex flex-col gap-1.5">
                {notes.examFocus.map((focus, i) => (
                  <li key={i} className="flex gap-2 text-[13px] leading-relaxed text-ink/85">
                    <span aria-hidden className="text-accent-dim">•</span>
                    {focus}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {notes.citations.length > 0 && (
            <div className="border-t border-line pt-3">
              <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted/60">Grounded in</p>
              <ul className="mt-2 flex flex-col gap-1.5">
                {notes.citations.map((c) => (
                  <li key={c.citationId} className="text-[11.5px] text-muted">
                    {c.filename} · page {c.pageNumber}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
