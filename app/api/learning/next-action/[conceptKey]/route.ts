import { NextRequest, NextResponse } from "next/server";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { getNextLearningAction, PedagogyValidationError } from "@/lib/pedagogy/select-action";

export const runtime = "nodejs";

// Read-only (Step 29): no write route exists anywhere in this API surface, and no client-provided
// learner signal is ever accepted -- every signal the decision consumes is derived server-side from
// authoritative state. Gemini is never called on this path (§27's zero-Gemini-imports guarantee).
export async function GET(_request: NextRequest, context: { params: Promise<{ conceptKey: string }> }) {
  const { conceptKey } = await context.params;
  try {
    const profile = await getOrCreateDefaultProfile();
    const result = await getNextLearningAction(profile.id, conceptKey);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof PedagogyValidationError) return NextResponse.json({ error: "Concept not found." }, { status: 404 });
    return NextResponse.json({ error: "Could not compute the next learning action." }, { status: 500 });
  }
}
