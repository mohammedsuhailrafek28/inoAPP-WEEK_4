"use client";

import React from "react";

interface IconButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  badge?: number;
  children: React.ReactNode;
}

// A small, semantic header icon-button (Step 35: real <button>, aria-label, visible focus ring).
export default function IconButton({ label, onClick, disabled = false, badge, children }: IconButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="relative grid h-8 w-8 flex-shrink-0 place-items-center rounded-sm text-muted transition-colors hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
      {typeof badge === "number" && badge > 0 && (
        <span
          aria-hidden
          className="absolute right-0.5 top-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-accent px-[3px] text-[9px] font-semibold leading-none text-canvas"
        >
          {badge > 9 ? "9+" : badge}
        </span>
      )}
    </button>
  );
}
