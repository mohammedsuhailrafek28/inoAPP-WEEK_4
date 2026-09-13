"use client";

import React, { useEffect, useState } from "react";
import type { FlashcardsGenerationResult, GeneratedFlashcardSet } from "@/types/materials";

interface FlashcardsViewProps {
  conceptKey: string;
  conceptDisplayName: string;
  documentIds: string[];
  onBack: () => void;
}

type Phase = "loading" | "ready" | "insufficient" | "no-documents" | "failed";

export default function FlashcardsView({ conceptKey, conceptDisplayName, documentIds, onBack }: FlashcardsViewProps) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [set, setSet] = useState<GeneratedFlashcardSet | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);

  const load = async () => {
    if (documentIds.length === 0) {
      setPhase("no-documents");
      return;
    }
    setPhase("loading");
    setErrorMessage(null);
    setIndex(0);
    setRevealed(false);
    try {
      const response = await fetch("/api/materials/flashcards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conceptKey, documentIds }),
      });
      const data = (await response.json()) as FlashcardsGenerationResult | { error: string };
      if ("status" in data) {
        if (data.status === "generated") {
          setSet(data.flashcards);
          setPhase("ready");
        } else if (data.status === "insufficient_evidence") {
          setPhase("insufficient");
        } else {
          setErrorMessage(data.reason);
          setPhase("failed");
        }
      } else {
        setErrorMessage(data.error ?? "Could not generate flashcards.");
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

  const card = set?.cards[index] ?? null;
  const isLastCard = set ? index >= set.cards.length - 1 : true;

  return (
    <div className="flex flex-col gap-5">
      <button
        type="button"
        onClick={onBack}
        className="self-start text-[11px] font-medium uppercase tracking-[0.16em] text-muted underline decoration-line-strong underline-offset-4 hover:text-ink hover:decoration-accent"
      >
        ← Back to plan
      </button>

      {phase === "loading" && <p className="text-[13px] text-muted">Writing flashcards on {conceptDisplayName}…</p>}

      {phase === "no-documents" && <p className="text-[13px] leading-relaxed text-muted">Select one or more ready documents in the workspace first — flashcards are grounded in your own material.</p>}

      {phase === "insufficient" && (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] leading-relaxed text-muted">There isn&rsquo;t enough material in your selected documents to ground flashcards on {conceptDisplayName} yet.</p>
          <button type="button" onClick={() => void load()} className="self-start text-[11px] font-medium uppercase tracking-[0.16em] text-ink underline decoration-line-strong underline-offset-4 hover:decoration-accent">
            Try again
          </button>
        </div>
      )}

      {phase === "failed" && (
        <div className="flex flex-col gap-3">
          <p role="alert" className="text-[13px] leading-relaxed text-[#e9a991]">
            {errorMessage ?? "Something went wrong generating these flashcards."}
          </p>
          <button type="button" onClick={() => void load()} className="self-start text-[11px] font-medium uppercase tracking-[0.16em] text-ink underline decoration-line-strong underline-offset-4 hover:decoration-accent">
            Try again
          </button>
        </div>
      )}

      {phase === "ready" && card && set && (
        <div className="flex flex-col gap-5">
          <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted/60">
            Card {index + 1} of {set.cards.length}
          </p>

          <div className="min-h-[140px] rounded-lg border border-line bg-elevated-2 px-5 py-6">
            <p className="text-[15px] leading-relaxed text-ink">{card.front}</p>
            {revealed && (
              <p className="mt-4 border-t border-line pt-4 text-[13.5px] leading-relaxed text-ink/85">{card.back}</p>
            )}
          </div>

          {card.citations.length > 0 && revealed && (
            <p className="text-[11px] text-muted/60">
              Grounded in {card.citations.map((c) => `${c.filename} · page ${c.pageNumber}`).join(", ")}
            </p>
          )}

          <div className="flex gap-3">
            {!revealed ? (
              <button
                type="button"
                onClick={() => setRevealed(true)}
                className="rounded-lg bg-accent px-4 py-2 text-[11px] font-medium uppercase tracking-[0.18em] text-canvas transition-[background-color,transform] hover:bg-[#c7f04f] active:scale-[0.98] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                Reveal
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  if (isLastCard) return;
                  setIndex((i) => i + 1);
                  setRevealed(false);
                }}
                disabled={isLastCard}
                className="rounded-lg border border-line-strong px-4 py-2 text-[11px] font-medium uppercase tracking-[0.18em] text-ink transition-colors hover:border-accent/60 hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40"
              >
                Next
              </button>
            )}
          </div>

          {isLastCard && revealed && <p className="text-[11.5px] text-muted/60">That&rsquo;s the last card in this set.</p>}
        </div>
      )}
    </div>
  );
}
