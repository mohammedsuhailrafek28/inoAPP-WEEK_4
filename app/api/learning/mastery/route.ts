import { NextResponse } from "next/server";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { getConcept } from "@/lib/learning/concepts";
import { hasSufficientEvidence, isMastered, listMasteryStates } from "@/lib/learning/mastery";

export const runtime = "nodejs";

// Read-only (Step 16/17/18): there is no write route anywhere in this API surface. Mastery is
// mutated only by lib/learning/mastery.ts::applyLearningOutcome(), called from trusted server
// code -- never from a client-facing endpoint.
export async function GET() {
  try {
    const profile = await getOrCreateDefaultProfile();
    const states = await listMasteryStates(profile.id);
    const concepts = await Promise.all(states.map((state) => getConcept(state.conceptId)));

    const items = states.map((state, index) => {
      const concept = concepts[index];
      const evidenceSufficient = hasSufficientEvidence(state);
      return {
        concept: concept ? { id: concept.id, conceptKey: concept.conceptKey, displayName: concept.displayName, subject: concept.subject } : null,
        masteryProbability: state.pMastery,
        mastered: evidenceSufficient && isMastered(state.pMastery),
        evidenceSufficient,
        opportunities: state.evidenceCount,
        successes: state.correctCount,
        failures: state.incorrectCount,
        lastPracticedAt: state.lastPracticedAt,
      };
    });

    return NextResponse.json({ mastery: items });
  } catch {
    return NextResponse.json({ error: "Could not load mastery state." }, { status: 500 });
  }
}
