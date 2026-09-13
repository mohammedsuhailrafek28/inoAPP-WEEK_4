import { NextRequest, NextResponse } from "next/server";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { getConceptByKey } from "@/lib/learning/concepts";
import { getConceptStatus } from "@/lib/learning/olm";

export const runtime = "nodejs";

// Step 25's single-concept summary -- the same route-pairing convention as /api/learning/mastery
// (+/[conceptKey]) etc. Read-only; stage/why/visibility gates are entirely server-derived.
export async function GET(_request: NextRequest, context: { params: Promise<{ conceptKey: string }> }) {
  const { conceptKey } = await context.params;
  try {
    const concept = await getConceptByKey(conceptKey);
    if (!concept) return NextResponse.json({ error: "Concept not found." }, { status: 404 });

    const profile = await getOrCreateDefaultProfile();
    const status = await getConceptStatus(profile.id, concept.id);
    return NextResponse.json(status);
  } catch {
    return NextResponse.json({ error: "Could not load concept progress." }, { status: 500 });
  }
}
