"use client";

import React from "react";
import type { AgentActivityRecord } from "@/types/agent-activity";
import type { ConceptSummary } from "@/types/progress";
import { AGENT_ACTIVITY_KIND_LABEL } from "@/lib/ui/labels";

interface RecentActivityProps {
  activity: AgentActivityRecord[];
  concepts: ConceptSummary[];
}

// Week 4, Phase C: a compact, human-readable trail of autonomous decisions -- never raw JSON, never
// an internal id, never a "trace" console. Every sentence is built only from already-server-decided
// fields (kind, reasonCodes, metadata) via the same "1:1 presentation lookup" rule lib/ui/labels.ts
// already establishes for everything else in this product.
function describeActivity(entry: AgentActivityRecord, conceptNameByKey: Map<string, string>): string {
  const base = AGENT_ACTIVITY_KIND_LABEL[entry.kind];
  const conceptName = entry.conceptKey ? conceptNameByKey.get(entry.conceptKey) : null;

  if (entry.kind === "MATERIAL_GENERATED") {
    const materialType = entry.metadata.materialType === "flashcards" ? "Flashcards" : "Notes";
    return conceptName ? `${materialType} generated for ${conceptName}` : base;
  }

  if (entry.kind === "PLAN_GENERATED" || entry.kind === "PLAN_REPLANNED") {
    const minutes = typeof entry.metadata.availableMinutes === "number" ? entry.metadata.availableMinutes : null;
    const suffix = minutes ? ` for ${minutes} minutes` : "";
    const focus = conceptName ? ` — ${conceptName} prioritized` : "";
    return `${base}${suffix}${focus}`;
  }

  return conceptName ? `${base} — ${conceptName}` : base;
}

export default function RecentActivity({ activity, concepts }: RecentActivityProps) {
  if (activity.length === 0) return null;
  const conceptNameByKey = new Map(concepts.map((c) => [c.conceptKey, c.displayName]));

  return (
    <section className="border-t border-line pt-4">
      <h3 className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted">Recent decisions</h3>
      <ul className="mt-3 flex flex-col gap-2">
        {activity.map((entry) => (
          <li key={entry.id} className="text-[12px] leading-relaxed text-muted">
            {describeActivity(entry, conceptNameByKey)}
          </li>
        ))}
      </ul>
    </section>
  );
}
