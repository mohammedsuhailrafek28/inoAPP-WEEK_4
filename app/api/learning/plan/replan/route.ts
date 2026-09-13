import { NextRequest, NextResponse } from "next/server";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { replanLearningPlan } from "@/lib/plan/replan";
import { PlanValidationError } from "@/lib/plan/budget";
import { ConceptValidationError } from "@/lib/learning/concepts";
import { PedagogyValidationError } from "@/lib/pedagogy/select";
import { PLAN_MAX_AVAILABLE_MINUTES, PLAN_MIN_AVAILABLE_MINUTES } from "@/lib/plan/constants";

export const runtime = "nodejs";

// POST /api/learning/plan/replan -- Week 4, Phase D. Recomputes a plan from CURRENT learner state
// (never a cached one) and logs it as PLAN_REPLANNED rather than PLAN_GENERATED. Body:
// {subject, minutes, skippedConceptIds?, completedConceptId?} -- the client may never supply a
// priority, ordering, or duration; every one of those stays server-resolved, identical to
// GET /api/learning/plan's own authority boundary.
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { subject, minutes, skippedConceptIds, completedConceptId } = (body ?? {}) as {
    subject?: unknown;
    minutes?: unknown;
    skippedConceptIds?: unknown;
    completedConceptId?: unknown;
  };

  if (typeof subject !== "string" || !subject.trim()) return NextResponse.json({ error: "A subject is required." }, { status: 400 });
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || !Number.isInteger(minutes)) {
    return NextResponse.json({ error: "minutes must be a whole number." }, { status: 400 });
  }
  if (minutes < PLAN_MIN_AVAILABLE_MINUTES || minutes > PLAN_MAX_AVAILABLE_MINUTES) {
    return NextResponse.json({ error: `minutes must be between ${PLAN_MIN_AVAILABLE_MINUTES} and ${PLAN_MAX_AVAILABLE_MINUTES}.` }, { status: 400 });
  }
  if (skippedConceptIds !== undefined && (!Array.isArray(skippedConceptIds) || !skippedConceptIds.every((id) => typeof id === "string"))) {
    return NextResponse.json({ error: "skippedConceptIds must be an array of strings." }, { status: 400 });
  }
  if (completedConceptId !== undefined && completedConceptId !== null && typeof completedConceptId !== "string") {
    return NextResponse.json({ error: "completedConceptId must be a string." }, { status: 400 });
  }

  try {
    const profile = await getOrCreateDefaultProfile();
    const plan = await replanLearningPlan(profile.id, subject, minutes, {
      skippedConceptIds: skippedConceptIds as string[] | undefined,
      completedConceptId: completedConceptId as string | null | undefined,
    });
    return NextResponse.json(plan);
  } catch (error) {
    if (error instanceof PlanValidationError || error instanceof ConceptValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof PedagogyValidationError) return NextResponse.json({ error: error.message }, { status: 404 });
    return NextResponse.json({ error: "Could not replan." }, { status: 500 });
  }
}
