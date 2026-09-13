import { NextRequest, NextResponse } from "next/server";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { evaluateTeachBackFollowUp, TeachBackValidationError } from "@/lib/teach-back/service";

export const runtime = "nodejs";

// POST /api/learning/teach-back/follow-up -- Teach-Back / Feynman Mode, turn 2 (final). Input is
// {conceptKey, documentIds, originalExplanation, followUpQuestion, followUpAnswer} -- the client
// retains the first evaluation's own conceptKey/documentIds and the followUpQuestion it was shown;
// no server-side session is persisted for this two-turn interaction (deliberately kept this small,
// per this feature's own scope boundary). Never mutates learner state.
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { conceptKey, documentIds, originalExplanation, followUpQuestion, followUpAnswer } = (body ?? {}) as {
    conceptKey?: unknown;
    documentIds?: unknown;
    originalExplanation?: unknown;
    followUpQuestion?: unknown;
    followUpAnswer?: unknown;
  };

  try {
    const profile = await getOrCreateDefaultProfile();
    const result = await evaluateTeachBackFollowUp(profile.id, {
      conceptKey: conceptKey as string,
      documentIds: documentIds as string[],
      originalExplanation: originalExplanation as string,
      followUpQuestion: followUpQuestion as string,
      followUpAnswer: followUpAnswer as string,
    });
    if (result.status === "evaluated") return NextResponse.json(result);
    if (result.status === "insufficient_evidence") return NextResponse.json(result, { status: 422 });
    return NextResponse.json(result, { status: 502 });
  } catch (error) {
    if (error instanceof TeachBackValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: "Could not evaluate this follow-up answer." }, { status: 500 });
  }
}
