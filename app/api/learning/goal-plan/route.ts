import { NextRequest, NextResponse } from "next/server";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { generateGoalPlan, GoalPlanValidationError } from "@/lib/goal-plan/generate";
import { ConceptValidationError } from "@/lib/learning/concepts";
import { PedagogyValidationError } from "@/lib/pedagogy/select";
import { PLAN_MAX_AVAILABLE_MINUTES, PLAN_MIN_AVAILABLE_MINUTES } from "@/lib/plan/constants";

export const runtime = "nodejs";

// GET /api/learning/goal-plan?subject=...&examDate=YYYY-MM-DD&minutesPerDay=...&regenerate=true
// Standout feature: Exam Goal Mode. Read-only, computed on demand, mirrors GET /api/learning/plan's
// exact conventions (subject required, getOrCreateDefaultProfile() for the single-user studentId,
// bounds validated here before any work so a bad request never reaches the generator). `regenerate`
// affects only which agent-activity kind gets logged ("Adapt Roadmap" vs. a fresh roadmap) -- the
// computation itself is identical either way, always freshly derived from current state.
export async function GET(request: NextRequest) {
  const subject = request.nextUrl.searchParams.get("subject");
  if (!subject || !subject.trim()) return NextResponse.json({ error: "A subject query parameter is required." }, { status: 400 });

  const examDate = request.nextUrl.searchParams.get("examDate");
  if (!examDate || !examDate.trim()) return NextResponse.json({ error: "An examDate query parameter is required." }, { status: 400 });

  const minutesPerDayParam = request.nextUrl.searchParams.get("minutesPerDay");
  if (!minutesPerDayParam || !minutesPerDayParam.trim()) return NextResponse.json({ error: "A minutesPerDay query parameter is required." }, { status: 400 });
  const minutesPerDay = Number(minutesPerDayParam);
  if (!Number.isFinite(minutesPerDay) || !Number.isInteger(minutesPerDay)) {
    return NextResponse.json({ error: "minutesPerDay must be a whole number." }, { status: 400 });
  }
  if (minutesPerDay < PLAN_MIN_AVAILABLE_MINUTES || minutesPerDay > PLAN_MAX_AVAILABLE_MINUTES) {
    return NextResponse.json({ error: `minutesPerDay must be between ${PLAN_MIN_AVAILABLE_MINUTES} and ${PLAN_MAX_AVAILABLE_MINUTES}.` }, { status: 400 });
  }

  const regenerate = request.nextUrl.searchParams.get("regenerate") === "true";

  try {
    const profile = await getOrCreateDefaultProfile();
    const goalPlan = await generateGoalPlan(profile.id, subject, examDate, minutesPerDay, { activityKind: regenerate ? "PLAN_REPLANNED" : "PLAN_GENERATED" });
    return NextResponse.json(goalPlan);
  } catch (error) {
    if (error instanceof GoalPlanValidationError || error instanceof ConceptValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof PedagogyValidationError) return NextResponse.json({ error: error.message }, { status: 404 });
    return NextResponse.json({ error: "Could not generate an exam roadmap." }, { status: 500 });
  }
}
