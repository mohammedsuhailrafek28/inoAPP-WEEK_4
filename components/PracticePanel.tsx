"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { ConceptSummary, Quiz, QuizGenerationResult, QuizQuestion, QuizSubmissionResult } from "@/types/progress";
import { ACTION_LABEL, DIFFICULTY_LABEL } from "@/lib/ui/labels";

interface PracticePanelProps {
  initialSubject: string | null;
  documentIds: string[];
}

type Phase = "idle" | "loading" | "question" | "submitting" | "result" | "adapting" | "not-eligible" | "insufficient" | "no-documents" | "failed";

function conceptName(conceptId: string, concepts: Map<string, ConceptSummary>): string {
  return concepts.get(conceptId)?.displayName ?? "this concept";
}

/** The one-question-at-a-time adaptive loop (ARCHITECTURE.md §18/§20, Phase 9), for a fixed subject. */
function QuizFlow({ subject, documentIds, concepts }: { subject: string; documentIds: string[]; concepts: Map<string, ConceptSummary> }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [question, setQuestion] = useState<QuizQuestion | null>(null);
  const [rationale, setRationale] = useState<string[]>([]);
  const [notEligibleAction, setNotEligibleAction] = useState<string | null>(null);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [shortAnswerText, setShortAnswerText] = useState("");
  const [result, setResult] = useState<QuizSubmissionResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const requestQuestion = useCallback(async () => {
    if (documentIds.length === 0) {
      setPhase("no-documents");
      return;
    }
    setPhase("loading");
    setErrorMessage(null);
    setSelectedOption(null);
    setShortAnswerText("");
    setResult(null);
    try {
      const response = await fetch("/api/quiz/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, documentIds }),
      });
      const data = (await response.json()) as QuizGenerationResult;
      if (data.status === "generated") {
        setQuiz(data.quiz);
        setQuestion(data.question);
        setRationale(data.rationale);
        setPhase("question");
      } else if (data.status === "not_eligible") {
        setNotEligibleAction(data.action);
        setPhase("not-eligible");
      } else if (data.status === "insufficient_evidence") {
        setPhase("insufficient");
      } else {
        setErrorMessage(data.reason || "This question couldn't be generated.");
        setPhase("failed");
      }
    } catch {
      setErrorMessage("A network error stopped this from loading.");
      setPhase("failed");
    }
  }, [subject, documentIds]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void requestQuestion(); }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject, documentIds.join(",")]);

  const handleSubmit = async () => {
    if (!quiz || !question) return;
    const submittedAnswer = question.questionType === "mcq" ? selectedOption : shortAnswerText.trim();
    if (!submittedAnswer) return;
    setPhase("submitting");
    setErrorMessage(null);
    try {
      const response = await fetch(`/api/quiz/${quiz.id}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId: question.id, submittedAnswer }),
      });
      const data = (await response.json()) as QuizSubmissionResult & { error?: string };
      if (!response.ok) throw new Error(data.error || "That answer couldn't be submitted.");
      setResult(data);
      setPhase("result");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "That answer couldn't be submitted.");
      setPhase("failed");
    }
  };

  const handleNext = () => {
    setPhase("adapting");
    window.setTimeout(() => void requestQuestion(), 550); // Step 21: a deliberate beat, never an instant static swap
  };

  const isPrerequisiteRedirect = useMemo(() => quiz && rationale.includes("PREREQUISITE_BLOCKED"), [quiz, rationale]);

  if (phase === "idle" || phase === "loading") {
    return <p className="text-[13px] text-muted">Preparing your next question…</p>;
  }

  if (phase === "adapting") {
    return (
      <p className="text-[13px] text-muted" style={{ animation: "pulse-soft 1.4s ease-in-out infinite" }}>
        Adjusting your next activity…
      </p>
    );
  }

  if (phase === "no-documents") {
    return <p className="text-[13px] leading-relaxed text-muted">Select one or more ready documents in the workspace first — practice questions are grounded in your own material.</p>;
  }

  if (phase === "insufficient") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-[13px] leading-relaxed text-muted">There isn&rsquo;t enough material in your selected documents to ground a question on this topic yet.</p>
        <button type="button" onClick={() => void requestQuestion()} className="self-start text-[11px] font-medium uppercase tracking-[0.16em] text-ink underline decoration-line-strong underline-offset-4 hover:decoration-accent">
          Try again
        </button>
      </div>
    );
  }

  if (phase === "not-eligible") {
    return (
      <p className="text-[13px] leading-relaxed text-muted">
        Right now the best next step isn&rsquo;t a practice question — it&rsquo;s to <strong className="text-ink/90">{ACTION_LABEL[(notEligibleAction as keyof typeof ACTION_LABEL) ?? "CONTINUE"]}</strong>. Head back to chat to continue, or check Progress for what&rsquo;s recommended next.
      </p>
    );
  }

  if (phase === "failed") {
    return (
      <div className="flex flex-col gap-3">
        <p role="alert" className="text-[13px] leading-relaxed text-[#e9a991]">
          {errorMessage ?? "Something went wrong generating this question."}
        </p>
        <button type="button" onClick={() => void requestQuestion()} className="self-start text-[11px] font-medium uppercase tracking-[0.16em] text-ink underline decoration-line-strong underline-offset-4 hover:decoration-accent">
          Try again
        </button>
      </div>
    );
  }

  if (phase === "result" && result && question) {
    const isShortAnswer = question.questionType === "short_answer";
    return (
      <div className="flex flex-col gap-5">
        <div>
          <p className={`text-[11px] font-medium uppercase tracking-[0.18em] ${result.correct ? "text-accent-dim" : "text-[#e9a991]"}`}>
            {result.correct ? "Correct" : "Not quite"}
            {isShortAnswer && <span className="ml-2 text-muted/60">· AI-assessed</span>}
          </p>
          {result.feedback && <p className="mt-2 text-[13px] leading-relaxed text-ink/85">{result.feedback}</p>}
          {result.alreadyProcessed && <p className="mt-2 text-[11px] text-muted/60">This question was already answered.</p>}
        </div>
        <button
          type="button"
          onClick={handleNext}
          className="self-start rounded-lg border border-line-strong px-4 py-2 text-[11px] font-medium uppercase tracking-[0.18em] text-ink transition-[color,border-color] hover:border-accent/60 hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Next question
        </button>
      </div>
    );
  }

  if (phase === "question" || phase === "submitting") {
    if (!question || !quiz) return null;
    const canSubmit = question.questionType === "mcq" ? !!selectedOption : shortAnswerText.trim().length > 0;
    return (
      <div className="flex flex-col gap-5">
        {isPrerequisiteRedirect && (
          <p className="rounded-lg border border-line bg-elevated-2 px-3.5 py-3 text-[12px] leading-relaxed text-muted">
            Before continuing, let&rsquo;s revisit <span className="text-ink/90">{conceptName(quiz.targetConceptId, concepts)}</span> — it&rsquo;s foundational for what you asked about.
          </p>
        )}

        <div>
          <p className="text-[13px] font-medium text-ink/90">{conceptName(question.conceptId, concepts)}</p>
          <p className="mt-0.5 text-[10px] uppercase tracking-[0.16em] text-muted/60">{DIFFICULTY_LABEL[quiz.difficulty]}</p>
        </div>

        <p className="text-[15px] leading-relaxed text-ink">{question.questionText}</p>

        {question.questionType === "mcq" && question.options ? (
          <div role="radiogroup" aria-label="Answer options" className="flex flex-col gap-2">
            {question.options.map((option) => {
              const active = selectedOption === option;
              return (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setSelectedOption(option)}
                  disabled={phase === "submitting"}
                  className={`rounded-lg border px-3.5 py-2.5 text-left text-[13px] transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-60 ${
                    active ? "border-accent/60 bg-accent/[0.06] text-ink" : "border-line text-ink/85 hover:border-line-strong"
                  }`}
                >
                  {option}
                </button>
              );
            })}
          </div>
        ) : (
          <textarea
            value={shortAnswerText}
            onChange={(e) => setShortAnswerText(e.target.value)}
            disabled={phase === "submitting"}
            placeholder="Write your answer…"
            aria-label="Your answer"
            rows={4}
            className="w-full resize-none rounded-lg border border-line bg-elevated-2 px-3.5 py-3 text-[13px] text-ink outline-none transition-colors focus:border-accent/55 disabled:opacity-60"
          />
        )}

        {question.citations.length > 0 && (
          <div className="border-t border-line pt-3">
            <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted/60">Grounded in</p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {question.citations.map((c) => (
                <li key={c.citationId} className="text-[11.5px] text-muted">
                  {c.filename} · page {c.pageNumber}
                </li>
              ))}
            </ul>
          </div>
        )}

        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={!canSubmit || phase === "submitting"}
          className="self-start rounded-lg bg-accent px-4 py-2 text-[11px] font-medium uppercase tracking-[0.18em] text-canvas transition-[background-color,transform] hover:bg-[#c7f04f] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {phase === "submitting" ? "Submitting…" : "Submit"}
        </button>
      </div>
    );
  }

  return null;
}

export default function PracticePanel({ initialSubject, documentIds }: PracticePanelProps) {
  const [concepts, setConcepts] = useState<ConceptSummary[]>([]);
  // Lazy initial state only -- no effect needed to keep this synced with `initialSubject`: this
  // component is fully unmounted whenever its enclosing Drawer closes (Drawer returns null while
  // `open` is false), so a fresh mount already re-reads whatever `initialSubject` is current at
  // that moment. Once mounted, local subject-picker selections are free to override it.
  const [subject, setSubject] = useState<string | null>(initialSubject);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/learning/concepts");
        const data = (await response.json()) as { concepts?: ConceptSummary[] };
        if (!cancelled && Array.isArray(data.concepts)) setConcepts(data.concepts);
      } catch {
        /* concept display names / subject list are a presentation nicety, not required for the quiz flow to function */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const conceptsById = useMemo(() => new Map(concepts.map((c) => [c.id, c])), [concepts]);
  const subjects = useMemo(() => [...new Set(concepts.map((c) => c.subject))].sort(), [concepts]);

  if (!subject) {
    if (subjects.length === 0) return <p className="text-[13px] leading-relaxed text-muted">No subjects are set up yet.</p>;
    return (
      <div className="flex flex-col gap-4">
        <p className="text-[13px] leading-relaxed text-muted">Choose a subject to practice.</p>
        <div className="flex flex-wrap gap-2">
          {subjects.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSubject(s)}
              className="rounded-full border border-line-strong px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-ink transition-colors hover:border-accent/60 hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return <QuizFlow key={subject} subject={subject} documentIds={documentIds} concepts={conceptsById} />;
}
