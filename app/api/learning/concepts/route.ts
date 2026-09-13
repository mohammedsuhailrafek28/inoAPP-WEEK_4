import { NextRequest, NextResponse } from "next/server";
import { listConcepts, listConceptsBySubject, ConceptValidationError } from "@/lib/learning/concepts";

export const runtime = "nodejs";

// Read-only (Step 17): concept creation is server/seed-driven only, per the locked architecture --
// there is deliberately no POST here to mutate the graph. See app/api/learning/concepts/[key]/route.ts
// for a single concept's detail, including its prerequisites/dependents.
export async function GET(request: NextRequest) {
  const subject = request.nextUrl.searchParams.get("subject");
  try {
    const concepts = subject ? await listConceptsBySubject(subject) : await listConcepts();
    return NextResponse.json({ concepts });
  } catch (error) {
    if (error instanceof ConceptValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: "Could not load concepts." }, { status: 500 });
  }
}
