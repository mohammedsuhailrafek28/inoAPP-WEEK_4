"use client";

import React, { useState } from "react";
import type { ConceptSummary, PedagogicalReasonCode, RevisionReasonCode } from "@/types/progress";
import type { GoalPlan, GoalPlanDay } from "@/types/goal-plan";
import { ACTION_LABEL, PEDAGOGICAL_REASON_LABEL, PLAN_ACTIVITY_TYPE_LABEL, REVISION_REASON_LABEL } from "@/lib/ui/labels";

interface GoalPlanViewProps {
  subject: string;
  concepts: ConceptSummary[];
  onPracticeSubject: (subject: string) => void;
}

const MINUTE_PRESETS = [15, 30, 45, 60] as const;
// Mirrors lib/goal-plan/constants.ts::GOAL_PLAN_MAX_HORIZON_DAYS -- kept as a local literal (the
// same convention PlanPanel.tsx's own MINUTE_PRESETS already uses) rather than importing a
// lib/goal-plan/* constant into a client component, so this file's only intelligence-bearing input
// stays the server's own response.
const MAX_HORIZON_DAYS = 14;

const REASON_DISPLAY_PRIORITY: RevisionReasonCode[] = ["PREREQUISITE_BLOCKER", "ACTIVE_MISCONCEPTION", "REVIEW_DUE", "TRANSFER_NOT_DEMONSTRATED", "PRACTICE_PLATEAU", "MASTERY_DEVELOPING"];
function primaryReasonCode(codes: RevisionReasonCode[]): RevisionReasonCode {
  return REASON_DISPLAY_PRIORITY.find((code) => codes.includes(code)) ?? codes[0];
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function maxIso(): string {
  const d = new Date();
  d.setDate(d.getDate() + MAX_HORIZON_DAYS);
  return d.toISOString().slice(0, 10);
}

function formatDayLabel(date: string): string {
  // en-US short month/day, e.g. "Sep 13" -- presentation only, the date itself is server-supplied.
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function DayItems({ day }: { day: GoalPlanDay }) {
  if (day.items.length === 0) {
    return <p className="mt-1.5 text-[12px] leading-relaxed text-muted">No further ranked activities remain for this day yet.</p>;
  }
  return (
    <ul className="mt-1.5 flex flex-col gap-2.5">
      {day.items.map((item) => (
        <li key={`${item.conceptId}-${item.order}`} className="flex items-start gap-3">
          <span className="mt-0.5 text-[11px] font-medium tabular-nums text-muted/50">{String(item.order).padStart(2, "0")}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <p className="text-[13px] text-ink/90">
                {PLAN_ACTIVITY_TYPE_LABEL[item.activityType]} <span className="text-ink">{item.displayName}</span>
              </p>
              <span className="flex-shrink-0 text-[10px] font-medium uppercase tracking-[0.16em] text-muted/60">{item.estimatedMinutes}m</span>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function GoalPlanView({ subject, concepts, onPracticeSubject }: GoalPlanViewProps) {
  const [examDate, setExamDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 10);
  });
  const [minutesPerDay, setMinutesPerDay] = useState(30);
  const [roadmap, setRoadmap] = useState<GoalPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [adapting, setAdapting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (regenerate: boolean) => {
    (regenerate ? setAdapting : setLoading)(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/learning/goal-plan?subject=${encodeURIComponent(subject)}&examDate=${encodeURIComponent(examDate)}&minutesPerDay=${minutesPerDay}${regenerate ? "&regenerate=true" : ""}`,
      );
      const data = (await response.json()) as GoalPlan & { error?: string };
      if (!response.ok) throw new Error(data.error || "Could not generate the exam roadmap.");
      setRoadmap(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate the exam roadmap.");
    } finally {
      (regenerate ? setAdapting : setLoading)(false);
    }
  };

  const today = roadmap?.days[0] ?? null;
  const futureDays = roadmap ? roadmap.days.slice(1) : [];
  const nextAction = roadmap?.nextBestAction.decision ?? null;
  const nextActionConceptName = nextAction ? concepts.find((c) => c.conceptKey === nextAction.targetConceptKey)?.displayName ?? nextAction.targetConceptKey : null;
  const nextActionReason = nextAction && nextAction.reasonCodes.length > 0 ? PEDAGOGICAL_REASON_LABEL[nextAction.reasonCodes[0] as PedagogicalReasonCode] : null;

  // "Why this plan?" -- built entirely from TODAY's already-server-computed reasonCodes, the same
  // deterministic labels every other panel in this product already uses. No Gemini call, no new
  // reason codes invented for this section.
  const whyLines = (today?.items ?? [])
    .filter((item) => item.reasonCodes.length > 0)
    .map((item) => `${item.displayName} ${REVISION_REASON_LABEL[primaryReasonCode(item.reasonCodes)].toLowerCase()}${item.reasonCodes.includes("PREREQUISITE_BLOCKER") ? "" : "."}`);

  return (
    <div className="flex flex-col gap-7">
      <section className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted/70">Exam date</span>
            <input
              type="date"
              value={examDate}
              min={todayIso()}
              max={maxIso()}
              onChange={(e) => setExamDate(e.target.value)}
              className="rounded-md border border-line-strong bg-elevated-2 px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-accent/60"
            />
          </label>
        </div>
        <div>
          <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted/70">Study time / day</span>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {MINUTE_PRESETS.map((preset) => {
              const active = minutesPerDay === preset;
              return (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setMinutesPerDay(preset)}
                  aria-pressed={active}
                  disabled={loading || adapting}
                  className={`rounded-full border px-3.5 py-1.5 text-[11px] font-medium tabular-nums tracking-[0.1em] transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-50 ${
                    active ? "border-accent/60 bg-accent/[0.08] text-ink" : "border-line-strong text-ink hover:border-accent/60 hover:text-accent"
                  }`}
                >
                  {preset} min
                </button>
              );
            })}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load(false)}
          disabled={loading || adapting}
          className="mt-1 self-start rounded-lg bg-accent px-4 py-2 text-[11px] font-medium uppercase tracking-[0.18em] text-canvas transition-[background-color,transform] hover:bg-[#c7f04f] active:scale-[0.98] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-50"
        >
          {loading ? "Building roadmap…" : "Create roadmap"}
        </button>
      </section>

      {error && (
        <p role="alert" className="text-[13px] leading-relaxed text-[#e9a991]">
          {error}
        </p>
      )}

      {roadmap && !error && (
        <>
          <section>
            <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted/60">{roadmap.subject} exam</p>
            <p className="mt-1 text-[15px] text-ink/90">
              {roadmap.daysRemaining} {roadmap.daysRemaining === 1 ? "day" : "days"} remaining
            </p>
          </section>

          <section className="rounded-lg border border-line bg-elevated-2 px-4 py-3.5">
            <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted/60">Readiness</p>
            <p className="mt-1 text-[22px] font-medium text-ink">{roadmap.readiness.readyPercent}%</p>
            <p className="mt-0.5 text-[11.5px] text-muted">
              {roadmap.readiness.readyConceptCount} of {roadmap.readiness.totalConceptCount} concepts ready
            </p>
            {(roadmap.readiness.reviewDueCount > 0 || roadmap.readiness.activeMisconceptionCount > 0) && (
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted/80">
                {roadmap.readiness.reviewDueCount > 0 && <>{roadmap.readiness.reviewDueCount} concept{roadmap.readiness.reviewDueCount === 1 ? "" : "s"} need review</>}
                {roadmap.readiness.reviewDueCount > 0 && roadmap.readiness.activeMisconceptionCount > 0 && " · "}
                {roadmap.readiness.activeMisconceptionCount > 0 && <>{roadmap.readiness.activeMisconceptionCount} unresolved misconception{roadmap.readiness.activeMisconceptionCount === 1 ? "" : "s"}</>}
              </p>
            )}
          </section>

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

          {today && (
            <section>
              <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted">
                Today · {today.availableMinutes} min
              </p>
              <DayItems day={today} />
            </section>
          )}

          {futureDays.length > 0 && (
            <section className="flex flex-col gap-4">
              {futureDays.map((day) => (
                <div key={day.date}>
                  <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted/60">{day.isExamDay ? `Final day · ${formatDayLabel(day.date)}` : formatDayLabel(day.date)}</p>
                  <DayItems day={day} />
                </div>
              ))}
            </section>
          )}

          {whyLines.length > 0 && (
            <section className="border-t border-line pt-4">
              <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted">Why this plan?</p>
              <ul className="mt-2 flex flex-col gap-1.5">
                {whyLines.map((line, i) => (
                  <li key={i} className="text-[12px] leading-relaxed text-muted">
                    {line}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="border-t border-line pt-4">
            <p className="text-[11.5px] leading-relaxed text-muted">
              Your roadmap is generated from your current learning state. Complete learning activities and regenerate it to adapt the remaining days.
            </p>
            <button
              type="button"
              onClick={() => void load(true)}
              disabled={adapting}
              className="mt-3 self-start rounded-lg border border-line-strong px-4 py-2 text-[11px] font-medium uppercase tracking-[0.18em] text-ink transition-colors hover:border-accent/60 hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-50"
            >
              {adapting ? "Adapting…" : "Adapt roadmap"}
            </button>
          </section>
        </>
      )}
    </div>
  );
}
