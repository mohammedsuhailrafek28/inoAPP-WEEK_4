import { NextResponse } from "next/server";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { hasSufficientAbilityEvidence, listAbilities } from "@/lib/learning/ability";

export const runtime = "nodejs";

// Read-only (Step 24): there is no write route anywhere in this API surface. Ability is mutated
// only by lib/learning/ability.ts::applyAbilityOutcome(), called from trusted server code -- never
// from a client-facing endpoint. No client can set theta.
export async function GET() {
  try {
    const profile = await getOrCreateDefaultProfile();
    const abilities = await listAbilities(profile.id);
    return NextResponse.json({
      abilities: abilities.map((ability) => ({
        subject: ability.subject,
        theta: ability.theta,
        observationCount: ability.observationCount,
        correctCount: ability.correctCount,
        incorrectCount: ability.incorrectCount,
        evidenceSufficient: hasSufficientAbilityEvidence(ability),
        lastObservedAt: ability.lastObservedAt,
      })),
    });
  } catch {
    return NextResponse.json({ error: "Could not load ability state." }, { status: 500 });
  }
}
