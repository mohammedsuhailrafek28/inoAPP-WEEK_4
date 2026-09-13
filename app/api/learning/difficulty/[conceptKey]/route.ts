import { NextRequest, NextResponse } from "next/server";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { getConceptByKey } from "@/lib/learning/concepts";
import { getTargetDifficulty } from "@/lib/pedagogy/difficulty";

export const runtime = "nodejs";

// Read-only difficulty recommendation (Step 24) -- the Phase 9 quiz-selection contract (Step 23),
// exposed for inspection now. Generates no quiz question; Gemini is never invoked here.
export async function GET(_request: NextRequest, context: { params: Promise<{ conceptKey: string }> }) {
  const { conceptKey } = await context.params;
  try {
    const concept = await getConceptByKey(conceptKey);
    if (!concept) return NextResponse.json({ error: "Concept not found." }, { status: 404 });

    const profile = await getOrCreateDefaultProfile();
    const result = await getTargetDifficulty(profile.id, concept.id);
    return NextResponse.json({ concept: { id: concept.id, conceptKey: concept.conceptKey, displayName: concept.displayName, subject: concept.subject }, ...result });
  } catch {
    return NextResponse.json({ error: "Could not compute a difficulty recommendation." }, { status: 500 });
  }
}
