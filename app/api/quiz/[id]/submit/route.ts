import { NextRequest, NextResponse } from "next/server";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { submitQuizAnswer, QuizValidationError } from "@/lib/quiz/service";
import { QuizScoringError } from "@/lib/quiz/evaluation";

export const runtime = "nodejs";

// ARCHITECTURE.md §28's locked route. The client submits only {questionId, submittedAnswer,
// responseTimeMs?} -- correctness, difficulty, concept, and every derived learner-state update are
// entirely server-resolved (§32: "Client-submitted quiz score/mastery delta ... Authoritative
// writer: Server re-evaluates from stored correct_answer every time").
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { questionId, submittedAnswer, responseTimeMs } = (body ?? {}) as { questionId?: unknown; submittedAnswer?: unknown; responseTimeMs?: unknown };

  try {
    const profile = await getOrCreateDefaultProfile();
    const result = await submitQuizAnswer(profile.id, id, {
      questionId: questionId as string,
      submittedAnswer: submittedAnswer as string,
      responseTimeMs: typeof responseTimeMs === "number" ? responseTimeMs : undefined,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof QuizValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof QuizScoringError) return NextResponse.json({ error: error.message }, { status: 502 });
    return NextResponse.json({ error: "Could not submit the quiz answer." }, { status: 500 });
  }
}
