import { NextRequest, NextResponse } from "next/server";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { generateIntervention, InterventionValidationError } from "@/lib/intervention/generate";
import { getConceptByKey, normalizeSubjectKey, ConceptValidationError } from "@/lib/learning/concepts";

export const runtime = "nodejs";

// GET /api/learning/intervention?conceptKey=...&subject=...&recheck=true
// Standout feature: Misconception Intervention Coach. Read-only, computed fresh on every call --
// there is no persisted intervention record, so a plain re-fetch IS "Recheck Progress" (mirrors
// GET /api/learning/plan/GET /api/learning/goal-plan's own "no separate endpoint needed" reasoning).
// `conceptKey` is the sole authoritative identifier; `subject` is optional and, if given, is checked
// against the resolved concept's own subject rather than trusted directly -- a concept's subject is
// never a second, independently-client-supplied fact. `recheck` affects only which agent-activity
// kind gets logged (PLAN_REPLANNED vs. PLAN_GENERATED), matching Exam Goal Mode's `regenerate` flag.
export async function GET(request: NextRequest) {
  const conceptKey = request.nextUrl.searchParams.get("conceptKey");
  if (!conceptKey || !conceptKey.trim()) return NextResponse.json({ error: "A conceptKey query parameter is required." }, { status: 400 });

  const subjectParam = request.nextUrl.searchParams.get("subject");
  const recheck = request.nextUrl.searchParams.get("recheck") === "true";

  try {
    const profile = await getOrCreateDefaultProfile();

    if (subjectParam && subjectParam.trim()) {
      const concept = await getConceptByKey(conceptKey);
      if (!concept) return NextResponse.json({ error: "Unknown concept." }, { status: 400 });
      if (concept.subject !== normalizeSubjectKey(subjectParam)) {
        return NextResponse.json({ error: "conceptKey does not belong to the given subject." }, { status: 400 });
      }
    }

    const intervention = await generateIntervention(profile.id, conceptKey, { activityKind: recheck ? "PLAN_REPLANNED" : "PLAN_GENERATED" });
    return NextResponse.json(intervention);
  } catch (error) {
    if (error instanceof InterventionValidationError || error instanceof ConceptValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: "Could not generate an intervention." }, { status: 500 });
  }
}
