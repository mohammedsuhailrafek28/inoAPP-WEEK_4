import { NextRequest, NextResponse } from "next/server";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { SessionError, getActiveSession, getOrStartSessionForMeaningfulActivity, recoverStaleSession, endSession } from "@/lib/learning/sessions";

export const runtime = "nodejs";

// GET reads current session state, running the same stale-timeout recovery check every other
// session-touching endpoint runs (ARCHITECTURE.md §31) -- a read never leaves a genuinely
// stale session looking "active" to the caller.
export async function GET() {
  try {
    const profile = await getOrCreateDefaultProfile();
    const session = await recoverStaleSession(profile.id);
    return NextResponse.json({ session });
  } catch {
    return NextResponse.json({ error: "Could not load the learning session." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request format." }, { status: 400 });
  }

  const action = body.action;
  if (action !== "start" && action !== "end") {
    return NextResponse.json({ error: "action must be 'start' or 'end'." }, { status: 400 });
  }
  // Loosely bounded here; startSession()/getOrStartSessionForMeaningfulActivity() run this
  // through normalizeSubjectKey() (Phase 2) before it ever reaches the database, so "Algorithms"
  // and "algorithms" resolve to the same subject identity. Automatic concept-per-question
  // derivation is a later phase's work.
  const subject = typeof body.subject === "string" && body.subject.trim() ? body.subject.trim().slice(0, 120) : undefined;

  try {
    const profile = await getOrCreateDefaultProfile();

    if (action === "start") {
      const session = await getOrStartSessionForMeaningfulActivity(profile.id, subject);
      return NextResponse.json({ session });
    }

    // action === "end": always the student's own current session, never a client-supplied id --
    // explicit end is authoritative and immediate (§31), but only for a session that actually exists.
    const active = await getActiveSession(profile.id);
    if (!active) return NextResponse.json({ session: null });
    const session = await endSession(active.id, profile.id, "explicit");
    return NextResponse.json({ session });
  } catch (error) {
    if (error instanceof SessionError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: "Could not update the learning session." }, { status: 500 });
  }
}
