"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { ConceptSummary, PedagogicalReasonCode } from "@/types/progress";
import type { LearningPlan, PlanItem } from "@/types/plan";
import type { RevisionReasonCode } from "@/types/progress";
import type { AgentActivityRecord } from "@/types/agent-activity";
import { ACTION_LABEL, PEDAGOGICAL_REASON_LABEL, PLAN_ACTIVITY_TYPE_LABEL, REVISION_REASON_LABEL, revisionIntentLabel } from "@/lib/ui/labels";
import NotesView from "@/components/NotesView";
import FlashcardsView from "@/components/FlashcardsView";
import TeachBackView from "@/components/TeachBackView";
import RecentActivity from "@/components/RecentActivity";
import GoalPlanView from "@/components/GoalPlanView";

interface PlanPanelProps {
  onPracticeSubject: (subject: string) => void;
  documentIds: string[];
}

type PlanMode = "today" | "goal";

const MINUTE_PRESETS = [15, 30, 45, 60] as const;

// The same priority order components/ProgressPanel.tsx's own primaryReasonCode() already uses --
// picks WHICH already-server-provided reason reads best as a single "why" line, never manufactures
// a new one.
const REASON_DISPLAY_PRIORITY: RevisionReasonCode[] = ["PREREQUISITE_BLOCKER", "ACTIVE_MISCONCEPTION", "REVIEW_DUE", "TRANSFER_NOT_DEMONSTRATED", "PRACTICE_PLATEAU", "MASTERY_DEVELOPING"];
function primaryReasonCode(codes: RevisionReasonCode[]): RevisionReasonCode {
  return REASON_DISPLAY_PRIORITY.find((code) => codes.includes(code)) ?? codes[0];
}

type MaterialView = { type: "notes" | "flashcards" | "teach-back"; conceptKey: string; conceptDisplayName: string };

interface PlanItemRowProps {
  item: PlanItem;
  onPractice: () => void;
  onOpenMaterial: (type: "notes" | "flashcards" | "teach-back") => void;
}

// Week 4, Phase 5: which CTAs make sense for this item's activity type -- "learn" opens grounded
// materials (there is no live-quiz activity to jump into yet for a not-ready concept); "practice"
// jumps straight into the existing Practice/quiz experience (no new MCQ code, per Phase C's own
// instruction); "review" offers both, since a spaced review may be either a quick requiz or a
// flashcard refresh.
function PlanItemRow({ item, onPractice, onOpenMaterial }: PlanItemRowProps) {
  const reason = item.reasonCodes.length > 0 ? REVISION_REASON_LABEL[primaryReasonCode(item.reasonCodes)] : "A good next step right now.";
  return (
    <li className="border-t border-line py-4 first:border-t-0">
      <div className="flex items-start gap-3.5">
        <span className="mt-0.5 text-[11px] font-medium tabular-nums text-muted/50">{String(item.order).padStart(2, "0")}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="text-[13px] text-ink/90">
              {PLAN_ACTIVITY_TYPE_LABEL[item.activityType]} <span className="text-ink">{item.displayName}</span>
            </p>
            <span className="flex-shrink-0 text-[10px] font-medium uppercase tracking-[0.16em] text-muted/60">{item.estimatedMinutes} min</span>
          </div>
          {item.reasonCodes.length > 0 && (
            <p className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-accent-dim">{revisionIntentLabel(item.reasonCodes)}</p>
          )}
          <p className="mt-1.5 text-[12px] leading-relaxed text-muted">{reason}</p>

          <div className="mt-2.5 flex flex-wrap gap-2">
            {item.activityType !== "learn" && (
              <button
                type="button"
                onClick={onPractice}
                className="rounded-md border border-line-strong px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.15em] text-ink transition-colors hover:border-accent/60 hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {item.activityType === "review" ? "Start review" : "Practice"}
              </button>
            )}
            <button
              type="button"
              onClick={() => onOpenMaterial("notes")}
              className="rounded-md border border-line-strong px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.15em] text-ink transition-colors hover:border-accent/60 hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Notes
            </button>
            <button
              type="button"
              onClick={() => onOpenMaterial("flashcards")}
              className="rounded-md border border-line-strong px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.15em] text-ink transition-colors hover:border-accent/60 hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Flashcards
            </button>
            {item.activityType !== "learn" && (
              <button
                type="button"
                onClick={() => onOpenMaterial("teach-back")}
                className="rounded-md border border-line-strong px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.15em] text-ink transition-colors hover:border-accent/60 hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                Teach it back
              </button>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

export default function PlanPanel({ onPracticeSubject, documentIds }: PlanPanelProps) {
  const [concepts, setConcepts] = useState<ConceptSummary[]>([]);
  const [subject, setSubject] = useState<string | null>(null);
  const [minutes, setMinutes] = useState<number>(30);
  const [plan, setPlan] = useState<LearningPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [replanning, setReplanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<AgentActivityRecord[]>([]);
  const [materialView, setMaterialView] = useState<MaterialView | null>(null);
  const [mode, setMode] = useState<PlanMode>("today");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/learning/concepts");
        const data = (await response.json()) as { concepts?: ConceptSummary[] };
        if (!cancelled && Array.isArray(data.concepts)) setConcepts(data.concepts);
      } catch {
        /* the subject/concept-name list is a presentation nicety, not required for the plan to load */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const subjects = useMemo(() => [...new Set(concepts.map((c) => c.subject))].sort(), [concepts]);

  const refreshActivity = useCallback(async (forSubject: string) => {
    try {
      const response = await fetch(`/api/agent-activity?subject=${encodeURIComponent(forSubject)}&limit=5`);
      const data = (await response.json()) as { activity?: AgentActivityRecord[] };
      if (Array.isArray(data.activity)) setActivity(data.activity);
    } catch {
      /* the recent-decisions list is a presentation nicety, never required for the plan itself */
    }
  }, []);

  const loadPlan = useCallback(
    async (forSubject: string, forMinutes: number) => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/learning/plan?subject=${encodeURIComponent(forSubject)}&minutes=${forMinutes}`);
        const data = (await response.json()) as LearningPlan & { error?: string };
        if (!response.ok) throw new Error(data.error || "Could not load today's plan.");
        setPlan(data);
        void refreshActivity(forSubject);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load today's plan.");
        setPlan(null);
      } finally {
        setLoading(false);
      }
    },
    [refreshActivity],
  );

  useEffect(() => {
    if (!subject) return;
    const timer = window.setTimeout(() => { void loadPlan(subject, minutes); }, 0);
    return () => window.clearTimeout(timer);
  }, [subject, minutes, loadPlan]);

  const handleReplan = useCallback(async () => {
    if (!subject) return;
    setReplanning(true);
    setError(null);
    try {
      const response = await fetch("/api/learning/plan/replan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, minutes }),
      });
      const data = (await response.json()) as LearningPlan & { error?: string };
      if (!response.ok) throw new Error(data.error || "Could not replan.");
      setPlan(data);
      void refreshActivity(subject);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not replan.");
    } finally {
      setReplanning(false);
    }
  }, [subject, minutes, refreshActivity]);

  if (!subject) {
    if (subjects.length === 0) return <p className="text-[13px] leading-relaxed text-muted">No subjects are set up yet.</p>;
    return (
      <div className="flex flex-col gap-4">
        <p className="text-[13px] leading-relaxed text-muted">Choose a subject to plan today&rsquo;s session.</p>
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

  if (materialView) {
    const commonProps = {
      conceptKey: materialView.conceptKey,
      conceptDisplayName: materialView.conceptDisplayName,
      documentIds,
      onBack: () => {
        setMaterialView(null);
        void refreshActivity(subject);
      },
    };
    if (materialView.type === "notes") return <NotesView {...commonProps} />;
    if (materialView.type === "flashcards") return <FlashcardsView {...commonProps} />;
    return <TeachBackView {...commonProps} subject={subject} onPracticeSubject={onPracticeSubject} />;
  }

  const modeToggle = (
    <div role="tablist" aria-label="Plan mode" className="flex gap-1 rounded-full border border-line-strong p-0.5">
      {(["today", "goal"] as const).map((m) => (
        <button
          key={m}
          type="button"
          role="tab"
          aria-selected={mode === m}
          onClick={() => setMode(m)}
          className={`rounded-full px-3 py-1 text-[10px] font-medium uppercase tracking-[0.15em] transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent ${
            mode === m ? "bg-accent text-canvas" : "text-muted hover:text-ink"
          }`}
        >
          {m === "today" ? "Today" : "Exam Goal"}
        </button>
      ))}
    </div>
  );

  if (mode === "goal") {
    return (
      <div className="flex flex-col gap-7">
        <div className="flex items-center justify-between">
          <h3 className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted">Exam goal</h3>
          {modeToggle}
        </div>
        <GoalPlanView subject={subject} concepts={concepts} onPracticeSubject={onPracticeSubject} />
      </div>
    );
  }

  const nextAction = plan?.nextBestAction.decision ?? null;
  const nextActionConceptName = nextAction ? concepts.find((c) => c.conceptKey === nextAction.targetConceptKey)?.displayName ?? nextAction.targetConceptKey : null;
  const nextActionReason = nextAction && nextAction.reasonCodes.length > 0 ? PEDAGOGICAL_REASON_LABEL[nextAction.reasonCodes[0] as PedagogicalReasonCode] : null;
  // Cold-start detection (Week 4 hardening, Step 6/8): reuses the already-server-computed next-best-
  // action reason rather than a new heuristic. An empty schedule means one of two very different
  // things -- "no learner evidence exists yet for this subject" (nextAction falls back to
  // INSUFFICIENT_EVIDENCE, or there's no concept at all) vs. "the chosen time budget was genuinely
  // too short for even one activity" -- and the two deserve honest, distinct copy rather than one
  // message that always blames the time budget.
  const isColdStart = !nextAction || nextAction.reasonCodes.includes("INSUFFICIENT_EVIDENCE");

  return (
    <div className="flex flex-col gap-7">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted">Today</h3>
        {modeToggle}
      </div>

      <section>
        <h3 className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted">Available study time</h3>
        <div className="mt-3 flex flex-wrap gap-2">
          {MINUTE_PRESETS.map((preset) => {
            const active = minutes === preset;
            return (
              <button
                key={preset}
                type="button"
                onClick={() => setMinutes(preset)}
                aria-pressed={active}
                disabled={loading || replanning}
                className={`rounded-full border px-3.5 py-1.5 text-[11px] font-medium tabular-nums tracking-[0.1em] transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-50 ${
                  active ? "border-accent/60 bg-accent/[0.08] text-ink" : "border-line-strong text-ink hover:border-accent/60 hover:text-accent"
                }`}
              >
                {preset} min
              </button>
            );
          })}
        </div>
      </section>

      {loading && <p className="text-[13px] text-muted">Building today&rsquo;s plan…</p>}

      {error && !loading && (
        <div className="flex flex-col gap-3">
          <p role="alert" className="text-[13px] leading-relaxed text-[#e9a991]">
            {error}
          </p>
          <button
            type="button"
            onClick={() => void loadPlan(subject, minutes)}
            className="self-start text-[11px] font-medium uppercase tracking-[0.16em] text-ink underline decoration-line-strong underline-offset-4 hover:decoration-accent"
          >
            Try again
          </button>
        </div>
      )}

      {plan && !loading && !error && (
        <>
          {nextAction && (
            <section className="rounded-lg border border-accent/30 bg-accent/[0.05] px-4 py-3.5">
              <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-accent-dim">Next best action</p>
              <p className="mt-1.5 text-[13px] text-ink/90">
                {ACTION_LABEL[nextAction.action]}
                {nextActionConceptName && <> — {nextActionConceptName}</>}
              </p>
              {nextActionReason && <p className="mt-1 text-[11.5px] leading-relaxed text-muted">{nextActionReason}</p>}
              <button
                type="button"
                onClick={() => onPracticeSubject(subject)}
                className="mt-3 rounded-lg bg-accent px-3.5 py-1.5 text-[11px] font-medium uppercase tracking-[0.16em] text-canvas transition-[background-color,transform] hover:bg-[#c7f04f] active:scale-[0.98] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                Start
              </button>
            </section>
          )}

          <section>
            <div className="flex items-baseline justify-between">
              <h3 className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted">Today&rsquo;s plan</h3>
              <button
                type="button"
                onClick={() => void handleReplan()}
                disabled={replanning}
                className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted underline decoration-line-strong underline-offset-4 transition-colors hover:text-ink hover:decoration-accent disabled:pointer-events-none disabled:opacity-50"
              >
                {replanning ? "Replanning…" : "Replan"}
              </button>
            </div>
            {plan.items.length === 0 ? (
              <p className="mt-3 text-[13px] leading-relaxed text-muted">
                {isColdStart
                  ? "No learning history yet for this subject. Start with Next best action above, or open Practice to begin building your progress — your plan fills in as real evidence comes in."
                  : `${minutes} minutes isn’t enough time to schedule a full activity here yet — try a longer session, or use Next best action above.`}
              </p>
            ) : (
              <ul className="mt-1">
                {plan.items.map((item) => (
                  <PlanItemRow
                    key={`${item.conceptId}-${item.order}`}
                    item={item}
                    onPractice={() => onPracticeSubject(item.subject)}
                    onOpenMaterial={(type) => setMaterialView({ type, conceptKey: item.conceptKey, conceptDisplayName: item.displayName })}
                  />
                ))}
              </ul>
            )}
          </section>

          <section className="flex items-center justify-between border-t border-line pt-4 text-[11px] uppercase tracking-[0.16em] text-muted/70">
            <span>
              {plan.items.length} {plan.items.length === 1 ? "activity" : "activities"}
            </span>
            <span>
              {plan.estimatedMinutes} of {plan.availableMinutes} minutes planned
            </span>
          </section>

          <RecentActivity activity={activity} concepts={concepts} />
        </>
      )}
    </div>
  );
}
