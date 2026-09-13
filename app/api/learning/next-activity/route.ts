import { NextRequest, NextResponse } from "next/server";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { selectNextActivity, PedagogyValidationError } from "@/lib/pedagogy/select";

export const runtime = "nodejs";

// ARCHITECTURE.md §28's locked route: GET {subject} -> {phase, conceptSelection, decision,
// nonAuthoritativeContext} (§17's full output). Unlike the Phase 8 concept-given
// /api/learning/next-action/[conceptKey], the client supplies ONLY a subject -- the concept itself
// is chosen server-side by §17.1/§17.2 (Phase 9), never accepted from the caller.
export async function GET(request: NextRequest) {
  const subject = request.nextUrl.searchParams.get("subject");
  if (!subject || !subject.trim()) return NextResponse.json({ error: "A subject query parameter is required." }, { status: 400 });

  try {
    const profile = await getOrCreateDefaultProfile();
    const result = await selectNextActivity(profile.id, subject);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof PedagogyValidationError) return NextResponse.json({ error: error.message }, { status: 404 });
    return NextResponse.json({ error: "Could not compute the next activity." }, { status: 500 });
  }
}
