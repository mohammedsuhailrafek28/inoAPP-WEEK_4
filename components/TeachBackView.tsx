"use client";

import React, { useState } from "react";
import type { TeachBackEvaluateResult, TeachBackEvaluation, TeachBackFollowUpEvaluateResult, TeachBackFollowUpResult } from "@/types/teach-back";
import { TEACH_BACK_UNDERSTANDING_LABEL } from "@/lib/ui/labels";
import NotesView from "@/components/NotesView";

interface TeachBackViewProps {
  conceptKey: string;
  conceptDisplayName: string;
  documentIds: string[];
  onBack: () => void;
  onPracticeSubject: (subject: string) => void;
  subject: string;
}

type Phase = "writing" | "checking" | "result" | "answering-follow-up" | "final" | "no-documents" | "insufficient" | "failed";

export default function TeachBackView({ conceptKey, conceptDisplayName, documentIds, onBack, onPracticeSubject, subject }: TeachBackViewProps) {
  const [phase, setPhase] = useState<Phase>(documentIds.length === 0 ? "no-documents" : "writing");
  const [explanation, setExplanation] = useState("");
  const [evaluation, setEvaluation] = useState<TeachBackEvaluation | null>(null);
  const [followUpAnswer, setFollowUpAnswer] = useState("");
  const [finalResult, setFinalResult] = useState<TeachBackFollowUpResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showNotes, setShowNotes] = useState(false);

  if (showNotes) {
    return <NotesView conceptKey={conceptKey} conceptDisplayName={conceptDisplayName} documentIds={documentIds} onBack={() => setShowNotes(false)} />;
  }

  const submitExplanation = async () => {
    if (!explanation.trim()) return;
    setPhase("checking");
    setErrorMessage(null);
    try {
      const response = await fetch("/api/learning/teach-back/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conceptKey, documentIds, explanation }),
      });
      const data = (await response.json()) as TeachBackEvaluateResult | { error: string };
      if ("status" in data) {
        if (data.status === "evaluated") {
          setEvaluation(data.evaluation);
          setPhase("result");
        } else if (data.status === "insufficient_evidence") {
          setPhase("insufficient");
        } else {
          setErrorMessage(data.reason);
          setPhase("failed");
        }
      } else {
        setErrorMessage(data.error ?? "Could not evaluate this explanation.");
        setPhase("failed");
      }
    } catch {
      setErrorMessage("A network error stopped this from loading.");
      setPhase("failed");
    }
  };

  const submitFollowUp = async () => {
    if (!evaluation || !followUpAnswer.trim()) return;
    setPhase("checking");
    setErrorMessage(null);
    try {
      const response = await fetch("/api/learning/teach-back/follow-up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conceptKey, documentIds, originalExplanation: explanation, followUpQuestion: evaluation.followUpQuestion, followUpAnswer }),
      });
      const data = (await response.json()) as TeachBackFollowUpEvaluateResult | { error: string };
      if ("status" in data) {
        if (data.status === "evaluated") {
          setFinalResult(data.result);
          setPhase("final");
        } else if (data.status === "insufficient_evidence") {
          setPhase("insufficient");
        } else {
          setErrorMessage(data.reason);
          setPhase("failed");
        }
      } else {
        setErrorMessage(data.error ?? "Could not evaluate this follow-up answer.");
        setPhase("failed");
      }
    } catch {
      setErrorMessage("A network error stopped this from loading.");
      setPhase("failed");
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <button
        type="button"
        onClick={onBack}
        className="self-start text-[11px] font-medium uppercase tracking-[0.16em] text-muted underline decoration-line-strong underline-offset-4 hover:text-ink hover:decoration-accent"
      >
        ← Back
      </button>

      <section>
        <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted/60">Teach it back</p>
        <p className="mt-1 text-[15px] text-ink/90">{conceptDisplayName}</p>
      </section>

      {phase === "no-documents" && <p className="text-[13px] leading-relaxed text-muted">Select one or more ready documents in the workspace first — Teach-Back is grounded in your own material.</p>}

      {(phase === "writing" || phase === "checking") && (
        <>
          <p className="text-[13px] leading-relaxed text-muted">Explain this concept in your own words, as if you were teaching someone who has never seen it.</p>
          <textarea
            value={explanation}
            onChange={(e) => setExplanation(e.target.value)}
            disabled={phase === "checking"}
            rows={7}
            placeholder="Start explaining…"
            aria-label="Your explanation"
            className="w-full resize-none rounded-lg border border-line bg-elevated-2 px-3.5 py-3 text-[13px] text-ink outline-none transition-colors focus:border-accent/55 disabled:opacity-60"
          />
          <button
            type="button"
            onClick={() => void submitExplanation()}
            disabled={phase === "checking" || !explanation.trim()}
            className="self-start rounded-lg bg-accent px-4 py-2 text-[11px] font-medium uppercase tracking-[0.18em] text-canvas transition-[background-color,transform] hover:bg-[#c7f04f] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {phase === "checking" ? "Checking…" : "Check my explanation"}
          </button>
        </>
      )}

      {phase === "insufficient" && (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] leading-relaxed text-muted">There isn&rsquo;t enough material in your selected documents to ground this check yet.</p>
          <button type="button" onClick={() => setPhase("writing")} className="self-start text-[11px] font-medium uppercase tracking-[0.16em] text-ink underline decoration-line-strong underline-offset-4 hover:decoration-accent">
            Back
          </button>
        </div>
      )}

      {phase === "failed" && (
        <div className="flex flex-col gap-3">
          <p role="alert" className="text-[13px] leading-relaxed text-[#e9a991]">
            {errorMessage ?? "Something went wrong checking this."}
          </p>
          <button type="button" onClick={() => setPhase(evaluation ? "answering-follow-up" : "writing")} className="self-start text-[11px] font-medium uppercase tracking-[0.16em] text-ink underline decoration-line-strong underline-offset-4 hover:decoration-accent">
            Try again
          </button>
        </div>
      )}

      {(phase === "result" || phase === "answering-follow-up") && evaluation && (
        <>
          <section>
            <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted">Understanding check</p>
            <p className="mt-1.5 text-[16px] text-ink">{TEACH_BACK_UNDERSTANDING_LABEL[evaluation.understanding]}</p>
          </section>

          {evaluation.strengths.length > 0 && (
            <section>
              <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted/60">What you explained well</p>
              <ul className="mt-2 flex flex-col gap-1.5">
                {evaluation.strengths.map((s, i) => (
                  <li key={i} className="flex gap-2 text-[12.5px] leading-relaxed text-ink/85">
                    <span aria-hidden className="text-accent-dim">✓</span>
                    {s}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {evaluation.missingIdeas.length > 0 && (
            <section>
              <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted/60">What&rsquo;s missing</p>
              <ul className="mt-2 flex flex-col gap-1.5">
                {evaluation.missingIdeas.map((s, i) => (
                  <li key={i} className="flex gap-2 text-[12.5px] leading-relaxed text-muted">
                    <span aria-hidden className="text-muted/60">△</span>
                    {s}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {evaluation.questionableClaims.length > 0 && (
            <section>
              <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted/60">Check this claim</p>
              <ul className="mt-2 flex flex-col gap-1.5">
                {evaluation.questionableClaims.map((s, i) => (
                  <li key={i} className="flex gap-2 text-[12.5px] leading-relaxed text-[#e9a991]">
                    <span aria-hidden>!</span>
                    {s}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="rounded-lg border border-accent/30 bg-accent/[0.05] px-4 py-3.5">
            <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-accent-dim">Next question</p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink/90">{evaluation.followUpQuestion}</p>
          </section>

          {phase === "result" && (
            <button
              type="button"
              onClick={() => setPhase("answering-follow-up")}
              className="self-start rounded-lg border border-line-strong px-4 py-2 text-[11px] font-medium uppercase tracking-[0.18em] text-ink transition-colors hover:border-accent/60 hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Answer follow-up
            </button>
          )}

          {phase === "answering-follow-up" && (
            <>
              <textarea
                value={followUpAnswer}
                onChange={(e) => setFollowUpAnswer(e.target.value)}
                rows={4}
                placeholder="Your answer…"
                aria-label="Your follow-up answer"
                className="w-full resize-none rounded-lg border border-line bg-elevated-2 px-3.5 py-3 text-[13px] text-ink outline-none transition-colors focus:border-accent/55"
              />
              <button
                type="button"
                onClick={() => void submitFollowUp()}
                disabled={!followUpAnswer.trim()}
                className="self-start rounded-lg bg-accent px-4 py-2 text-[11px] font-medium uppercase tracking-[0.18em] text-canvas transition-[background-color,transform] hover:bg-[#c7f04f] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                Submit answer
              </button>
            </>
          )}
        </>
      )}

      {phase === "final" && finalResult && (
        <>
          <section>
            <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted">Updated understanding</p>
            <p className="mt-1.5 text-[16px] text-ink">{TEACH_BACK_UNDERSTANDING_LABEL[finalResult.understanding]}</p>
          </section>

          {finalResult.strengths.length > 0 && (
            <section>
              <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted/60">What you explained well</p>
              <ul className="mt-2 flex flex-col gap-1.5">
                {finalResult.strengths.map((s, i) => (
                  <li key={i} className="flex gap-2 text-[12.5px] leading-relaxed text-ink/85">
                    <span aria-hidden className="text-accent-dim">✓</span>
                    {s}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {finalResult.missingIdeas.length > 0 && (
            <section>
              <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted/60">Still worth reviewing</p>
              <ul className="mt-2 flex flex-col gap-1.5">
                {finalResult.missingIdeas.map((s, i) => (
                  <li key={i} className="flex gap-2 text-[12.5px] leading-relaxed text-muted">
                    <span aria-hidden className="text-muted/60">△</span>
                    {s}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <p className="text-[11.5px] leading-relaxed text-muted">
            Teach-Back is a diagnostic check — it doesn&rsquo;t change your progress by itself. Practice or review this concept through the usual flow to update your progress.
          </p>

          <section className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setShowNotes(true)}
              className="rounded-md border border-line-strong px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.15em] text-ink transition-colors hover:border-accent/60 hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Review notes
            </button>
            <button
              type="button"
              onClick={() => onPracticeSubject(subject)}
              className="rounded-md bg-accent px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.15em] text-canvas transition-[background-color,transform] hover:bg-[#c7f04f] active:scale-[0.98] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Practice
            </button>
          </section>
        </>
      )}
    </div>
  );
}
