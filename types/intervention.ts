// Misconception Intervention Coach (standout feature, beyond Week 4 + Exam Goal Mode). Client-safe:
// no server-only import, mirroring the exact split every other types/*.ts file in this app uses.
// A LearningIntervention is a VIEW over current learner state, recomputed fresh on every call --
// never a persisted case/ticket, so there is no workflow state to manage beyond "is one needed right
// now, and why."

import type { PlanItem } from "@/types/plan";
import type { NextActivityResult, RevisionReasonCode } from "@/types/progress";

// Deliberately minimal (per this feature's own spec): a freshly-detected view either says an
// intervention is warranted right now, or it doesn't. No RESOLVED/ESCALATED/IN_PROGRESS -- this
// repository has no persisted intervention record for such a state to live on, and inventing one
// would be exactly the kind of manufactured workflow status this feature's spec explicitly forbids.
export const INTERVENTION_STATUSES = ["ACTIVE", "NOT_NEEDED"] as const;
export type InterventionStatus = (typeof INTERVENTION_STATUSES)[number];

// Mirrors the exact precedence lib/pedagogy/select-action.ts's own cascade already uses for these
// three signals (row 2: PREREQUISITE_BLOCKED, row 3: ACTIVE_MISCONCEPTION, row 4/DEVELOPING-stage
// territory) -- see lib/intervention/detect.ts's header comment for the full reasoning.
export const INTERVENTION_TRIGGERS = ["PREREQUISITE_GAP", "ACTIVE_MISCONCEPTION", "MASTERY_GAP"] as const;
export type InterventionTrigger = (typeof INTERVENTION_TRIGGERS)[number];

// Mirrors types/learning.ts's own PrerequisiteBlockerReasonCode verbatim -- not redeclared as a new
// vocabulary, just the client-safe surface of the same three existing values.
export type InterventionBlockerReasonCode = "PREREQUISITE_NOT_MASTERED" | "PREREQUISITE_EVIDENCE_INSUFFICIENT" | "PREREQUISITE_NO_EVIDENCE";

export interface InterventionBlocker {
  conceptId: string;
  conceptKey: string;
  displayName: string;
  reasonCode: InterventionBlockerReasonCode;
}

export interface InterventionMisconceptionDetail {
  tag: string;
  description: string;
}

export interface LearningIntervention {
  subject: string;
  targetConceptId: string;
  targetConceptKey: string;
  targetDisplayName: string;
  status: InterventionStatus;
  trigger: InterventionTrigger | null; // null exactly when status === "NOT_NEEDED"
  reasonCodes: RevisionReasonCode[]; // the exact existing reason code(s) that produced this verdict -- never invented
  why: string; // one deterministic, template-based sentence -- never Gemini-generated
  blocker: InterventionBlocker | null; // non-null only when trigger === "PREREQUISITE_GAP"
  misconception: InterventionMisconceptionDetail | null; // non-null only when trigger === "ACTIVE_MISCONCEPTION"
  // Which concept Notes/Flashcards/Practice CTAs should target -- the blocker when one exists,
  // otherwise the target concept itself. Lets the UI reuse NotesView/FlashcardsView/the existing
  // Practice hand-off verbatim without branching on trigger type itself.
  materialFocusConceptKey: string;
  materialFocusDisplayName: string;
  materialFocusSubject: string;
  recoveryItems: PlanItem[]; // reused verbatim from types/plan.ts -- no duplicate item shape
  nextBestAction: NextActivityResult; // lib/pedagogy/select.ts::selectNextActivity(), reused verbatim
  generatedAt: string;
}
