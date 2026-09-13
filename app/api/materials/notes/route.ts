import { NextRequest, NextResponse } from "next/server";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { generateNotesForConcept, MaterialValidationError } from "@/lib/materials/service";

export const runtime = "nodejs";

// POST /api/materials/notes -- Week 4, Phase A. Input is ONLY {conceptKey, documentIds}, mirroring
// POST /api/quiz/generate's own request-shape convention: the client never supplies mastery,
// priority, or any learner-state value.
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { conceptKey, documentIds } = (body ?? {}) as { conceptKey?: unknown; documentIds?: unknown };

  try {
    const profile = await getOrCreateDefaultProfile();
    const result = await generateNotesForConcept(profile.id, { conceptKey: conceptKey as string, documentIds: documentIds as string[] });
    if (result.status === "generated") return NextResponse.json(result);
    if (result.status === "insufficient_evidence") return NextResponse.json(result, { status: 422 });
    return NextResponse.json(result, { status: 502 });
  } catch (error) {
    if (error instanceof MaterialValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: "Could not generate notes." }, { status: 500 });
  }
}
