import React from "react";
import type { MasteryStage } from "@/types/progress";
import { STAGE_GLYPH, STAGE_LABEL } from "@/lib/ui/labels";

// The six-stage visual language (ARCHITECTURE.md §30.2, Phase 12 Step 8) -- restrained, not
// game-like, never color-only (a glyph + the label always render together, so removing color
// entirely still communicates the stage).
// Step 14 (Phase 13): REVIEW_DUE means "you learned this, it's time to refresh it," never "you
// failed this" -- it deliberately shares LEARNING/DEVELOPING's calm warm tone, not the coral
// reserved elsewhere in this app for genuine problem states (upload failures, active
// misconceptions), so it never reads as an error/alarm treatment.
const STAGE_TONE: Record<MasteryStage, string> = {
  NEW: "text-muted/70",
  LEARNING: "text-[#c9a86b]",
  DEVELOPING: "text-[#c9a86b]",
  PROFICIENT: "text-accent-dim",
  MASTERED: "text-accent",
  REVIEW_DUE: "text-[#c9a86b]",
};

export default function StageBadge({ stage, className = "" }: { stage: MasteryStage; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.16em] ${STAGE_TONE[stage]} ${className}`}>
      <span aria-hidden>{STAGE_GLYPH[stage]}</span>
      <span>{STAGE_LABEL[stage]}</span>
    </span>
  );
}
