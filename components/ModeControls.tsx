"use client";

import React from "react";
import { ExplanationMode, ExamMarks } from "@/types/chat";

interface ModeControlsProps {
  mode: ExplanationMode;
  onModeChange: (mode: ExplanationMode) => void;
  marks: ExamMarks;
  onMarksChange: (marks: ExamMarks) => void;
  disabled?: boolean;
  align?: "center" | "start";
}

const MODES: { value: ExplanationMode; label: string }[] = [
  { value: "simple", label: "Simple" },
  { value: "detailed", label: "Deep Dive" },
  { value: "exam", label: "Exam" },
];

const MARKS_OPTIONS: ExamMarks[] = [2, 5, 10, 16];

export default function ModeControls({
  mode,
  onModeChange,
  marks,
  onMarksChange,
  disabled = false,
  align = "center",
}: ModeControlsProps) {
  return (
    <div
      className={`flex flex-wrap items-center gap-x-6 gap-y-2 ${
        align === "center" ? "justify-center" : "justify-start"
      }`}
    >
      {MODES.map((m) => {
        const active = mode === m.value;
        return (
          <button
            key={m.value}
            onClick={() => onModeChange(m.value)}
            disabled={disabled}
            aria-pressed={active}
            className={`relative rounded-sm pb-1 text-[11px] font-medium uppercase tracking-[0.2em] transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40 ${
              active ? "text-ink" : "text-muted hover:text-ink"
            }`}
          >
            {m.label}
            <span
              className={`pointer-events-none absolute -bottom-px left-0 h-px w-full origin-left bg-accent transition-transform duration-300 ${
                active ? "scale-x-100" : "scale-x-0"
              }`}
            />
          </button>
        );
      })}

      {mode === "exam" && (
        <span className="flex items-center gap-4">
          <span aria-hidden className="h-3 w-px bg-line-strong" />
          <span className="flex items-center gap-3.5">
            {MARKS_OPTIONS.map((value) => {
              const active = marks === value;
              return (
                <button
                  key={value}
                  onClick={() => onMarksChange(value)}
                  disabled={disabled}
                  aria-pressed={active}
                  className={`relative rounded-sm pb-1 text-[11px] font-medium tabular-nums tracking-[0.1em] transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40 ${
                    active ? "text-ink" : "text-muted hover:text-ink"
                  }`}
                >
                  {value}
                  <span
                    className={`pointer-events-none absolute -bottom-px left-0 h-px w-full origin-left bg-accent transition-transform duration-300 ${
                      active ? "scale-x-100" : "scale-x-0"
                    }`}
                  />
                </button>
              );
            })}
          </span>
        </span>
      )}
    </div>
  );
}
