import { NextResponse } from "next/server";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { getScaffoldingDecision } from "@/lib/learning/autonomy";

export const runtime = "nodejs";

// Read-only (Step 9/31/37): scaffolding is student-scoped (§15's formula has no concept/subject
// input), derived entirely server-side. No client or LLM can set autonomy, level, or reasons --
// there is no write route anywhere in this API surface.
export async function GET() {
  try {
    const profile = await getOrCreateDefaultProfile();
    const decision = await getScaffoldingDecision(profile.id);
    return NextResponse.json(decision);
  } catch {
    return NextResponse.json({ error: "Could not compute a scaffolding decision." }, { status: 500 });
  }
}
