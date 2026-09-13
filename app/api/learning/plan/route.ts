import { NextRequest, NextResponse } from "next/server";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { generateLearningPlan } from "@/lib/plan/generate";
import { PlanValidationError } from "@/lib/plan/budget";
import { ConceptValidationError } from "@/lib/learning/concepts";
import { PedagogyValidationError } from "@/lib/pedagogy/select";
import { PLAN_MAX_AVAILABLE_MINUTES, PLAN_MIN_AVAILABLE_MINUTES } from "@/lib/plan/constants";

export const runtime = "nodejs";

// GET /api/learning/plan?subject=...&minutes=60 -- Week 4's time-budgeted learning plan (Phase 2).
// Read-only, computed on demand, never persisted -- follows GET /api/learning/next-activity's exact
// conventions (subject required, getOrCreateDefaultProfile() for the single-user studentId). The
// client supplies only `subject` and `minutes`; every priority/ordering/duration decision is
// resolved server-side (lib/plan/generate.ts), never accepted from the caller.
export async function GET(request: NextRequest) {
  const subject = request.nextUrl.searchParams.get("subject");
  if (!subject || !subject.trim()) return NextResponse.json({ error: "A subject query parameter is required." }, { status: 400 });

  const minutesParam = request.nextUrl.searchParams.get("minutes");
  if (!minutesParam || !minutesParam.trim()) return NextResponse.json({ error: "A minutes query parameter is required." }, { status: 400 });

  const minutes = Number(minutesParam);
  if (!Number.isFinite(minutes) || !Number.isInteger(minutes)) {
    return NextResponse.json({ error: "minutes must be a whole number." }, { status: 400 });
  }
  if (minutes < PLAN_MIN_AVAILABLE_MINUTES || minutes > PLAN_MAX_AVAILABLE_MINUTES) {
    return NextResponse.json({ error: `minutes must be between ${PLAN_MIN_AVAILABLE_MINUTES} and ${PLAN_MAX_AVAILABLE_MINUTES}.` }, { status: 400 });
  }

  try {
    const profile = await getOrCreateDefaultProfile();
    const plan = await generateLearningPlan(profile.id, subject, minutes);
    return NextResponse.json(plan);
  } catch (error) {
    if (error instanceof PlanValidationError || error instanceof ConceptValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof PedagogyValidationError) return NextResponse.json({ error: error.message }, { status: 404 });
    return NextResponse.json({ error: "Could not generate a learning plan." }, { status: 500 });
  }
}
