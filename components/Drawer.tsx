"use client";

import React, { useEffect, useRef } from "react";

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

// A lightweight overlay/drawer, per ARCHITECTURE.md §30.1's own locked UI decision ("No new
// page, no router... opens as a lightweight overlay/drawer, keeping the primary chat/quiz surface
// untouched when it's closed") -- reused for every Phase 12 surface (Progress, Practice, Profile),
// not just the Progress panel §30.1 originally described, since all three share the same "don't
// disturb the primary workspace" requirement.
export default function Drawer({ open, onClose, title, children }: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40" role="presentation">
      <button
        type="button"
        aria-label="Close panel"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-canvas/70 backdrop-blur-[2px]"
        style={{ animation: "fade-in 0.18s ease-out" }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="absolute inset-y-0 right-0 flex w-full max-w-[420px] flex-col border-l border-line bg-elevated shadow-2xl outline-none sm:max-w-[440px]"
        style={{ animation: "rise 0.28s cubic-bezier(0.16,1,0.3,1) both" }}
      >
        <div className="flex flex-shrink-0 items-center justify-between border-b border-line px-6 py-5">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.24em] text-ink">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-sm text-muted transition-colors hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-6 py-6">{children}</div>
      </div>
    </div>
  );
}
