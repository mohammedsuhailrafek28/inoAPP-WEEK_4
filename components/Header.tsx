"use client";

import React from "react";
import IconButton from "@/components/IconButton";

export type ActivePanel = "progress" | "practice" | "profile" | "plan" | null;

interface HeaderProps {
  onNewChat: () => void;
  canReset: boolean;
  disabled?: boolean;
  activePanel: ActivePanel;
  onGoToLearn: () => void;
  onOpenProgress: () => void;
  onOpenPractice: () => void;
  onOpenProfile: () => void;
  onOpenPlan: () => void;
  reviewDueCount?: number;
}

// Step 22's product-structure nav: LEARN / PRACTICE / PROGRESS / PROFILE, restrained text on
// laptop/desktop (lg+), the same three icon-buttons (already accessible via aria-label/title) on
// tablet/mobile where text would crowd the header. LEARN has no drawer of its own -- it simply
// closes whichever drawer is open, so it doubles as both "you are here" (Step 6) and "back to the
// workspace."
function NavTextItem({ label, active, onClick, badge }: { label: string; active: boolean; onClick: () => void; badge?: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`relative rounded-sm pb-1 text-[11px] font-medium uppercase tracking-[0.18em] transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-4 focus-visible:outline-accent ${
        active ? "text-ink" : "text-muted hover:text-ink"
      }`}
    >
      {label}
      {typeof badge === "number" && badge > 0 && <span className="ml-1.5 text-accent-dim">({badge > 9 ? "9+" : badge})</span>}
      <span
        aria-hidden
        className={`pointer-events-none absolute -bottom-px left-0 h-px w-full origin-left bg-accent transition-transform duration-300 ${
          active ? "scale-x-100" : "scale-x-0"
        }`}
      />
    </button>
  );
}

export default function Header({
  onNewChat,
  canReset,
  disabled = false,
  activePanel,
  onGoToLearn,
  onOpenProgress,
  onOpenPractice,
  onOpenProfile,
  onOpenPlan,
  reviewDueCount = 0,
}: HeaderProps) {
  return (
    <header className="flex-shrink-0 border-b border-line">
      <div className="mx-auto flex max-w-[1140px] items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2">
          <span aria-hidden className="text-[13px] leading-none text-accent">
            ✦
          </span>
          <span className="text-[12px] font-medium uppercase tracking-[0.2em] text-ink">
            Study
          </span>
        </div>

        {/* Laptop/desktop: restrained text navigation (Step 5/22). Plan is Week 4's addition -- the
            autonomous learning-plan surface -- placed next to Practice since both are "do
            something now" destinations, distinct from the more reflective Progress view. */}
        <nav aria-label="Sections" className="hidden items-center gap-6 lg:flex">
          <NavTextItem label="Learn" active={activePanel === null} onClick={onGoToLearn} />
          <NavTextItem label="Plan" active={activePanel === "plan"} onClick={onOpenPlan} />
          <NavTextItem label="Practice" active={activePanel === "practice"} onClick={onOpenPractice} />
          <NavTextItem label="Progress" active={activePanel === "progress"} onClick={onOpenProgress} badge={reviewDueCount} />
          <NavTextItem label="Profile" active={activePanel === "profile"} onClick={onOpenProfile} />
        </nav>

        <div className="flex items-center gap-1">
          {/* Tablet/mobile: the same drawers as compact, accessibly-labeled icons (Step 5/25). */}
          <div className="flex items-center gap-1 lg:hidden">
            <IconButton label="Plan" onClick={onOpenPlan}>
              <svg className="h-[18px] w-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 4h8M8 4v3.2c0 .5.2 1 .6 1.3L12 12l3.4 3.5c.4.3.6.8.6 1.3V20M8 20h8M8 20v-3.2c0-.5.2-1 .6-1.3L12 12" />
              </svg>
            </IconButton>
            <IconButton label="Practice" onClick={onOpenPractice}>
              <svg className="h-[18px] w-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4M12 3a9 9 0 1 0 9 9" />
              </svg>
            </IconButton>
            <IconButton label="Progress" onClick={onOpenProgress} badge={reviewDueCount}>
              <svg className="h-[18px] w-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 19V10M12 19V5M20 19v-6" />
              </svg>
            </IconButton>
            <IconButton label="Profile" onClick={onOpenProfile}>
              <svg className="h-[18px] w-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 20c1.6-3.6 4.8-5.5 8-5.5s6.4 1.9 8 5.5" />
              </svg>
            </IconButton>
          </div>

          <span aria-hidden className="mx-1.5 h-4 w-px bg-line-strong" />

          <button
            onClick={onNewChat}
            disabled={disabled || !canReset}
            className="rounded-sm text-[11px] font-medium uppercase tracking-[0.18em] text-[#c4c2bb] transition-colors hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-30"
            aria-label="Start a new chat"
          >
            New Chat
          </button>
        </div>
      </div>
    </header>
  );
}
