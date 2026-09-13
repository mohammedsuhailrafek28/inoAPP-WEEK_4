import { NextRequest, NextResponse } from "next/server";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { evaluateTeachBack, TeachBackValidationError } from "@/lib/teach-back/service";

export const runtime = "nodejs";

// POST /api/learning/teach-back/evaluate -- Teach-Back / Feynman Mode, turn 1. Input is
// {conceptKey, documentIds, explanation}, mirroring POST /api/materials/notes's own request-shape
// convention: the client never supplies understanding, mastery, or any learner-state value. This
// route never mutates learner state (see lib/teach-back/evidence-policy.ts).
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { conceptKey, documentIds, explanation } = (body ?? {}) as { conceptKey?: unknown; documentIds?: unknown; explanation?: unknown };

  try {
    const profile = await getOrCreateDefaultProfile();
    const result = await evaluateTeachBack(profile.id, { conceptKey: conceptKey as string, documentIds: documentIds as string[], explanation: explanation as string });
    if (result.status === "evaluated") return NextResponse.json(result);
    if (result.status === "insufficient_evidence") return NextResponse.json(result, { status: 422 });
    return NextResponse.json(result, { status: 502 });
  } catch (error) {
    if (error instanceof TeachBackValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: "Could not evaluate this explanation." }, { status: 500 });
  }
}
