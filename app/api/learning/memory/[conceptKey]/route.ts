import { NextRequest, NextResponse } from "next/server";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { getConceptByKey } from "@/lib/learning/concepts";
import { getLearnerMemoryContext } from "@/lib/learning/memory";

export const runtime = "nodejs";

// Read-only. Concept-scoped variant: episodes/misconceptions filtered to this concept.
export async function GET(_request: NextRequest, context: { params: Promise<{ conceptKey: string }> }) {
  const { conceptKey } = await context.params;
  try {
    const concept = await getConceptByKey(conceptKey);
    if (!concept) return NextResponse.json({ error: "Concept not found." }, { status: 404 });

    const profile = await getOrCreateDefaultProfile();
    const memoryContext = await getLearnerMemoryContext({ studentId: profile.id, conceptId: concept.id, subject: concept.subject });
    return NextResponse.json(memoryContext);
  } catch {
    return NextResponse.json({ error: "Could not load learner memory context." }, { status: 500 });
  }
}
