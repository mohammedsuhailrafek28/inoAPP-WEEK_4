import { NextRequest, NextResponse } from "next/server";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { listMisconceptions } from "@/lib/learning/misconceptions";
import type { MisconceptionStatus } from "@/types/learning";

export const runtime = "nodejs";

const VALID_STATUSES = new Set<MisconceptionStatus>(["candidate", "active", "resolved"]);

// Read-only (Step 24/35): there is no write route anywhere in this API surface. status/
// evidence_count are never client-settable -- lib/learning/misconceptions.ts::recordEvidence() is
// the sole writer, called only from trusted server code.
export async function GET(request: NextRequest) {
  try {
    const profile = await getOrCreateDefaultProfile();
    const statusParam = request.nextUrl.searchParams.get("status");
    const status = statusParam && VALID_STATUSES.has(statusParam as MisconceptionStatus) ? (statusParam as MisconceptionStatus) : undefined;
    const misconceptions = await listMisconceptions(profile.id, { status });
    return NextResponse.json({ misconceptions });
  } catch {
    return NextResponse.json({ error: "Could not load misconceptions." }, { status: 500 });
  }
}
