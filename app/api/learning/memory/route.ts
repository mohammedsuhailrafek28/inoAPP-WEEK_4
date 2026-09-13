import { NextRequest, NextResponse } from "next/server";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { getLearnerMemoryContext } from "@/lib/learning/memory";

export const runtime = "nodejs";

// Read-only (Step 31/37): structured, bounded memory context (Step 24) -- not integrated into RAG
// in this phase. No generic write route; no client-provided system memory (Step 31).
export async function GET(request: NextRequest) {
  try {
    const profile = await getOrCreateDefaultProfile();
    const subject = request.nextUrl.searchParams.get("subject") ?? undefined;
    const context = await getLearnerMemoryContext({ studentId: profile.id, subject });
    return NextResponse.json(context);
  } catch {
    return NextResponse.json({ error: "Could not load learner memory context." }, { status: 500 });
  }
}
