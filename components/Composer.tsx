"use client";

import React, { useRef, useEffect } from "react";
import { ExplanationMode, ExamMarks } from "@/types/chat";

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  mode: ExplanationMode;
  marks: ExamMarks;
  disabled?: boolean;
  variant?: "hero" | "sticky";
  placeholder?: string;
}

const MODE_LABEL: Record<ExplanationMode, string> = {
  simple: "Simple",
  detailed: "Deep Dive",
  exam: "Exam",
};

export default function Composer({
  value,
  onChange,
  onSend,
  mode,
  marks,
  disabled = false,
  variant = "sticky",
  placeholder = "Ask anything about your studies…",
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isHero = variant === "hero";

  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, isHero ? 200 : 160)}px`;
    }
  }, [value, isHero]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!disabled && value.trim()) onSend();
    }
  };

  const canSend = !disabled && value.trim().length > 0;
  const contextLabel =
    mode === "exam"
      ? `${MODE_LABEL.exam} · ${marks} Marks`
      : MODE_LABEL[mode];

  return (
    <div className="w-full">
      <div className="group relative rounded-2xl border border-line bg-elevated transition-colors duration-200 focus-within:border-accent/55 focus-within:bg-elevated-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={placeholder}
          rows={1}
          className={`w-full resize-none bg-transparent text-ink placeholder:text-muted/80 outline-none disabled:cursor-not-allowed disabled:opacity-50 ${
            isHero
              ? "px-5 py-4 pr-16 text-[16px] leading-relaxed"
              : "px-4 py-3 pr-14 text-[15px] leading-relaxed"
          }`}
          aria-label="Type your academic question"
        />
        <button
          onClick={onSend}
          disabled={!canSend}
          aria-label="Send message"
          className={`absolute grid place-items-center rounded-lg transition-[background-color,color,transform] duration-150 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent ${
            isHero ? "right-3 bottom-3 h-10 w-10" : "right-2.5 bottom-2.5 h-9 w-9"
          } ${
            canSend
              ? "bg-accent text-canvas hover:bg-[#c7f04f] active:scale-95"
              : "border border-line bg-transparent text-muted/70"
          }`}
        >
          <svg
            className={isHero ? "h-[18px] w-[18px]" : "h-4 w-4"}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </div>

      {!isHero && (
        <p className="mt-2 pl-1 text-[10px] font-medium uppercase tracking-[0.18em] text-muted/65">
          {contextLabel}
        </p>
      )}
    </div>
  );
}
