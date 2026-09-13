"use client";

import React, { useEffect, useState } from "react";
import type { LearningIntervention } from "@/types/intervention";
import { PLAN_ACTIVITY_TYPE_LABEL } from "@/lib/ui/labels";
import NotesView from "@/components/NotesView";
import FlashcardsView from "@/components/FlashcardsView";
import TeachBackView from "@/components/TeachBackView";

interface InterventionViewProps {
  conceptKey: string;
  documentIds: string[];
  onBack: () => void;
  onPracticeSubject: (subject: string) => void;
}

type MaterialView = { type: "notes" | "flashcards" | "teach-back" } | null;

export default function InterventionView({ conceptKey, documentIds, onBack, onPracticeSubject }: InterventionViewProps) {
  const [intervention, setIntervention] = useState<LearningIntervention | null>(null);
  const [loading, setLoading] = useState(true);
  const [rechecking, setRechecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [materialView, setMaterialView] = useState<MaterialView>(null);

  const load = async (recheck: boolean) => {
    (recheck ? setRechecking : setLoading)(true);
    setError(null);
    try {
      const response = await fetch(`/api/learning/intervention?conceptKey=${encodeURIComponent(conceptKey)}${recheck ? "&recheck=true" : ""}`);
      const data = (await response.json()) as LearningIntervention & { error?: string };
      if (!response.ok) throw new Error(data.error || "Could not load this recovery plan.");
      setIntervention(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load this recovery plan.");
    } finally {
      (recheck ? setRechecking : setLoading)(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(false); }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conceptKey]);

  if (materialView && intervention) {
    const commonProps = {
      conceptKey: intervention.materialFocusConceptKey,
      conceptDisplayName: intervention.materialFocusDisplayName,
      documentIds,
      onBack: () => setMaterialView(null),
    };
    if (materialView.type === "notes") return <NotesView {...commonProps} />;
    if (materialView.type === "flashcards") return <FlashcardsView {...commonProps} />;
    return <TeachBackView {...commonProps} subject={intervention.subject} onPracticeSubject={onPracticeSubject} />;
  }

  return (
    <div className="flex flex-col gap-6">
      <button
        type="button"
        onClick={onBack}
        className="self-start text-[11px] font-medium uppercase tracking-[0.16em] text-muted underline decoration-line-strong underline-offset-4 hover:text-ink hover:decoration-accent"
      >
        ← Back
      </button>

      {loading && <p className="text-[13px] text-muted">Building a recovery plan…</p>}

      {error && !loading && (
        <div className="flex flex-col gap-3">
          <p role="alert" className="text-[13px] leading-relaxed text-[#e9a991]">
            {error}
          </p>
          <button type="button" onClick={() => void load(false)} className="self-start text-[11px] font-medium uppercase tracking-[0.16em] text-ink underline decoration-line-strong underline-offset-4 hover:decoration-accent">
            Try again
          </button>
        </div>
      )}

      {intervention && !loading && !error && (
        <>
          <section>
            <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted/60">Recovery for</p>
            <p className="mt-1 text-[15px] text-ink/90">{intervention.targetDisplayName}</p>
          </section>

          {intervention.status === "NOT_NEEDED" ? (
            <p className="text-[13px] leading-relaxed text-muted">
              {intervention.targetDisplayName} no longer needs special attention based on current progress. Nice work.
            </p>
          ) : (
            <>
              {intervention.blocker && (
                <section className="rounded-lg border border-line bg-elevated-2 px-4 py-3.5">
                  <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted/60">Likely blocker</p>
                  <p className="mt-1 text-[13px] text-ink/90">{intervention.blocker.displayName}</p>
                </section>
              )}

              {intervention.misconception && (
                <section className="rounded-lg border border-line bg-elevated-2 px-4 py-3.5">
                  <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted/60">Learning gap</p>
                  <p className="mt-1 text-[13px] leading-relaxed text-ink/90">{intervention.misconception.description}</p>
                </section>
              )}

              <section>
                <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted">Why this recovery plan?</p>
                <p className="mt-2 text-[12.5px] leading-relaxed text-muted">{intervention.why}</p>
              </section>

              <section>
                <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted">Recovery plan</p>
                <ul className="mt-1">
                  {intervention.recoveryItems.map((item) => (
                    <li key={`${item.conceptId}-${item.order}`} className="border-t border-line py-3 first:border-t-0">
                      <div className="flex items-start gap-3">
                        <span className="mt-0.5 text-[11px] font-medium tabular-nums text-muted/50">{String(item.order).padStart(2, "0")}</span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                            <p className="text-[13px] text-ink/90">
                              {PLAN_ACTIVITY_TYPE_LABEL[item.activityType]} <span className="text-ink">{item.displayName}</span>
                            </p>
                            <span className="flex-shrink-0 text-[10px] font-medium uppercase tracking-[0.16em] text-muted/60">{item.estimatedMinutes} min</span>
                          </div>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setMaterialView({ type: "notes" })}
                  className="rounded-md border border-line-strong px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.15em] text-ink transition-colors hover:border-accent/60 hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  Notes
                </button>
                <button
                  type="button"
                  onClick={() => setMaterialView({ type: "flashcards" })}
                  className="rounded-md border border-line-strong px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.15em] text-ink transition-colors hover:border-accent/60 hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  Flashcards
                </button>
                <button
                  type="button"
                  onClick={() => setMaterialView({ type: "teach-back" })}
                  className="rounded-md border border-line-strong px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.15em] text-ink transition-colors hover:border-accent/60 hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  Teach it back
                </button>
                <button
                  type="button"
                  onClick={() => onPracticeSubject(intervention.subject)}
                  className="rounded-md bg-accent px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.15em] text-canvas transition-[background-color,transform] hover:bg-[#c7f04f] active:scale-[0.98] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  Practice
                </button>
              </section>
            </>
          )}

          <button
            type="button"
            onClick={() => void load(true)}
            disabled={rechecking}
            className="self-start rounded-lg border border-line-strong px-4 py-2 text-[11px] font-medium uppercase tracking-[0.18em] text-ink transition-colors hover:border-accent/60 hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-50"
          >
            {rechecking ? "Rechecking…" : "Recheck progress"}
          </button>
        </>
      )}
    </div>
  );
}
