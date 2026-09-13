import { NextRequest, NextResponse } from "next/server";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { generateQuiz, QuizValidationError } from "@/lib/quiz/service";
import { QuizGenerationError } from "@/lib/quiz/generate";

export const runtime = "nodejs";

// ARCHITECTURE.md §28's locked route. Input is ONLY {subject, documentIds} -- the client
// never supplies a concept, difficulty, or pedagogical action (Step 4); every authoritative choice
// comes from lib/pedagogy/select.ts::selectNextActivity(), called internally by generateQuiz(), not
// trusted from this request body (§28's own note: "now internally calls /learning/next-activity
// server-side rather than trusting a client-supplied topic").
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { subject, documentIds } = (body ?? {}) as { subject?: unknown; documentIds?: unknown };

  try {
    const profile = await getOrCreateDefaultProfile();
    const result = await generateQuiz(profile.id, { subject: subject as string, documentIds: documentIds as string[] });
    if (result.status === "generated") return NextResponse.json(result);
    if (result.status === "not_eligible") return NextResponse.json(result, { status: 409 });
    if (result.status === "insufficient_evidence") return NextResponse.json(result, { status: 422 });
    return NextResponse.json(result, { status: 502 });
  } catch (error) {
    if (error instanceof QuizValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof QuizGenerationError) return NextResponse.json({ error: error.message }, { status: 502 });
    return NextResponse.json({ error: "Could not generate a quiz question." }, { status: 500 });
  }
}
