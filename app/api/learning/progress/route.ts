import { NextRequest, NextResponse } from "next/server";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { listConcepts } from "@/lib/learning/concepts";
import { getSubjectAnalytics } from "@/lib/learning/analytics";

export const runtime = "nodejs";

// ARCHITECTURE.md §28's locked route, extended per §24 (Phase 11). Read-only (Step 39: no
// write path for stage/weak-strong labels/revision priority/progress/recommendation reason
// anywhere in this API surface) -- every value is derived server-side from authoritative learner
// state; the client may only filter (subject), never supply a learner-state field (Step 38).
export async function GET(request: NextRequest) {
  const subject = request.nextUrl.searchParams.get("subject");

  try {
    const profile = await getOrCreateDefaultProfile();

    if (subject) {
      const analytics = await getSubjectAnalytics(profile.id, subject);
      return NextResponse.json(analytics);
    }

    // No subject filter: bounded to the real, registered set of subjects (never fabricated) --
    // currently a handful of seeded subjects, not an unbounded scan.
    const concepts = await listConcepts();
    const subjects = [...new Set(concepts.map((concept) => concept.subject))].sort();
    const subjectsAnalytics = await Promise.all(subjects.map((s) => getSubjectAnalytics(profile.id, s)));
    return NextResponse.json({ subjects: subjectsAnalytics });
  } catch {
    return NextResponse.json({ error: "Could not load learning progress." }, { status: 500 });
  }
}
