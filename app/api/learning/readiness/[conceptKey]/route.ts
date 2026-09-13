import { NextRequest, NextResponse } from "next/server";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { getConceptByKey } from "@/lib/learning/concepts";
import { getPrerequisiteReadiness } from "@/lib/learning/readiness";

export const runtime = "nodejs";

// Read-only (Step 24/35): readiness is entirely derived on demand -- there is no persisted
// readiness state anywhere for a write route to expose or bypass. No Gemini involvement.
export async function GET(_request: NextRequest, context: { params: Promise<{ conceptKey: string }> }) {
  const { conceptKey } = await context.params;
  try {
    const concept = await getConceptByKey(conceptKey);
    if (!concept) return NextResponse.json({ error: "Concept not found." }, { status: 404 });

    const profile = await getOrCreateDefaultProfile();
    const readiness = await getPrerequisiteReadiness(profile.id, concept.id);
    return NextResponse.json(readiness);
  } catch {
    return NextResponse.json({ error: "Could not compute prerequisite readiness." }, { status: 500 });
  }
}
