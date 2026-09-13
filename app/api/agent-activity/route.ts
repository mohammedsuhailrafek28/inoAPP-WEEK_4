import { NextRequest, NextResponse } from "next/server";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { listAgentActivity } from "@/lib/learning/agent-activity";

export const runtime = "nodejs";

// GET /api/agent-activity?subject=...&limit=... -- Week 4, Phase C. Read-only, bounded, most-recent
// first. Subject filtering is optional (mirrors GET /api/learning/progress's own optional-subject
// convention) -- omitting it returns recent activity across every subject.
export async function GET(request: NextRequest) {
  const subject = request.nextUrl.searchParams.get("subject") ?? undefined;
  const limitParam = request.nextUrl.searchParams.get("limit");

  let limit: number | undefined;
  if (limitParam !== null) {
    limit = Number(limitParam);
    if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1) {
      return NextResponse.json({ error: "limit must be a positive whole number." }, { status: 400 });
    }
  }

  try {
    const profile = await getOrCreateDefaultProfile();
    const activity = await listAgentActivity(profile.id, { subject, limit });
    return NextResponse.json({ activity });
  } catch {
    return NextResponse.json({ error: "Could not load agent activity." }, { status: 500 });
  }
}
