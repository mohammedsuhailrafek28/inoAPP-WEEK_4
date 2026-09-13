import { NextRequest, NextResponse } from "next/server";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { generateFlashcardsForConcept, MaterialValidationError } from "@/lib/materials/service";

export const runtime = "nodejs";

// POST /api/materials/flashcards -- Week 4, Phase B. Same {conceptKey, documentIds} request shape
// as POST /api/materials/notes and POST /api/quiz/generate -- one consistent material-selection
// contract across all three generators.
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
    const result = await generateFlashcardsForConcept(profile.id, { conceptKey: conceptKey as string, documentIds: documentIds as string[] });
    if (result.status === "generated") return NextResponse.json(result);
    if (result.status === "insufficient_evidence") return NextResponse.json(result, { status: 422 });
    return NextResponse.json(result, { status: 502 });
  } catch (error) {
    if (error instanceof MaterialValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: "Could not generate flashcards." }, { status: 500 });
  }
}
