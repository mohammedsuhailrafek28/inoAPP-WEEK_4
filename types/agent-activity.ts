// Week 4, Phase C -- agent activity types. Client-safe: no server-only import, mirroring the same
// split every other types/*.ts file in this app uses. lib/learning/agent-activity.ts (server-only)
// imports these same declarations rather than redeclaring them -- one definition, two consumers,
// exactly like types/learning.ts's enums are shared between their owning lib/ module and the client.

export const AGENT_ACTIVITY_KINDS = ["PLAN_GENERATED", "PLAN_REPLANNED", "NEXT_ACTION_SELECTED", "MATERIAL_GENERATED"] as const;
export type AgentActivityKind = (typeof AGENT_ACTIVITY_KINDS)[number];

export interface AgentActivityRecord {
  id: string;
  studentId: string;
  subject: string;
  kind: AgentActivityKind;
  conceptId: string | null;
  conceptKey: string | null;
  reasonCodes: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
}
