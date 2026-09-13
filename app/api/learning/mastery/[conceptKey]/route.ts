import { NextRequest, NextResponse } from "next/server";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { getConceptByKey } from "@/lib/learning/concepts";
import { getMasteryState, getPracticeSignal, hasSufficientEvidence, isMastered } from "@/lib/learning/mastery";

export const runtime = "nodejs";

export async function GET(_request: NextRequest, context: { params: Promise<{ conceptKey: string }> }) {
  const { conceptKey } = await context.params;
  try {
    const concept = await getConceptByKey(conceptKey);
    if (!concept) return NextResponse.json({ error: "Concept not found." }, { status: 404 });

    const profile = await getOrCreateDefaultProfile();
    const [state, practiceSignal] = await Promise.all([
      getMasteryState(profile.id, concept.id),
      getPracticeSignal(profile.id, concept.id),
    ]);

    if (!state) {
      return NextResponse.json({
        concept: { id: concept.id, conceptKey: concept.conceptKey, displayName: concept.displayName, subject: concept.subject },
        masteryProbability: null,
        mastered: false,
        evidenceSufficient: false,
        opportunities: 0,
        successes: 0,
        failures: 0,
        lastPracticedAt: null,
        // PFA (§8): never a second mastery score -- exposed alongside, not blended into, mastery.
        practice: practiceSignal,
      });
    }

    const evidenceSufficient = hasSufficientEvidence(state);
    return NextResponse.json({
      concept: { id: concept.id, conceptKey: concept.conceptKey, displayName: concept.displayName, subject: concept.subject },
      masteryProbability: state.pMastery,
      mastered: evidenceSufficient && isMastered(state.pMastery),
      evidenceSufficient,
      opportunities: state.evidenceCount,
      successes: state.correctCount,
      failures: state.incorrectCount,
      lastPracticedAt: state.lastPracticedAt,
      practice: practiceSignal,
    });
  } catch {
    return NextResponse.json({ error: "Could not load mastery state." }, { status: 500 });
  }
}
