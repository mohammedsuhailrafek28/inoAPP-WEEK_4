import { NextRequest, NextResponse } from "next/server";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { getConceptByKey } from "@/lib/learning/concepts";
import { getTransferSignal } from "@/lib/learning/transfer";

export const runtime = "nodejs";

// Read-only (Step 24/35). Step 18's visibility rule: with zero transfer attempts, readiness reads
// "not_attempted" -- never a fabricated "demonstrated"/"ready" state.
export async function GET(_request: NextRequest, context: { params: Promise<{ conceptKey: string }> }) {
  const { conceptKey } = await context.params;
  try {
    const concept = await getConceptByKey(conceptKey);
    if (!concept) return NextResponse.json({ error: "Concept not found." }, { status: 404 });

    const profile = await getOrCreateDefaultProfile();
    const signal = await getTransferSignal(profile.id, concept.id);
    return NextResponse.json(signal);
  } catch {
    return NextResponse.json({ error: "Could not load transfer signal." }, { status: 500 });
  }
}
