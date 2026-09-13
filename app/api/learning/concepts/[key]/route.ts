import { NextRequest, NextResponse } from "next/server";
import { getConceptByKey, getStructuralPrerequisiteInfo, listDependents } from "@/lib/learning/concepts";

export const runtime = "nodejs";

// Read-only graph detail for one concept (Step 17): the concept itself, its direct/transitive
// structural prerequisite info, and its direct dependents. Deliberately NOT "readiness" -- that
// needs learner mastery, which doesn't exist until Phase 3 (ARCHITECTURE.md, Step 11).
export async function GET(_request: NextRequest, context: { params: Promise<{ key: string }> }) {
  const { key } = await context.params;
  try {
    const concept = await getConceptByKey(key);
    if (!concept) return NextResponse.json({ error: "Concept not found." }, { status: 404 });

    const [prerequisiteInfo, dependents] = await Promise.all([
      getStructuralPrerequisiteInfo(concept.id),
      listDependents(concept.id),
    ]);

    return NextResponse.json({
      concept,
      prerequisites: prerequisiteInfo.directPrerequisites,
      transitivePrerequisiteCount: prerequisiteInfo.transitivePrerequisiteCount,
      depth: prerequisiteInfo.depth,
      dependents: dependents.map((d) => ({ id: d.id, conceptKey: d.conceptKey, displayName: d.displayName, subject: d.subject })),
    });
  } catch {
    return NextResponse.json({ error: "Could not load the concept." }, { status: 500 });
  }
}
