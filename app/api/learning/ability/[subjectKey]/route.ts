import { NextRequest, NextResponse } from "next/server";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { normalizeSubjectKey } from "@/lib/learning/concepts";
import { getAbility, hasSufficientAbilityEvidence } from "@/lib/learning/ability";

export const runtime = "nodejs";

export async function GET(_request: NextRequest, context: { params: Promise<{ subjectKey: string }> }) {
  const { subjectKey } = await context.params;
  try {
    const subject = normalizeSubjectKey(subjectKey);
    const profile = await getOrCreateDefaultProfile();
    const ability = await getAbility(profile.id, subject);

    if (!ability) {
      return NextResponse.json({ subject, theta: 0, observationCount: 0, correctCount: 0, incorrectCount: 0, evidenceSufficient: false, lastObservedAt: null });
    }
    return NextResponse.json({
      subject: ability.subject,
      theta: ability.theta,
      observationCount: ability.observationCount,
      correctCount: ability.correctCount,
      incorrectCount: ability.incorrectCount,
      evidenceSufficient: hasSufficientAbilityEvidence(ability),
      lastObservedAt: ability.lastObservedAt,
    });
  } catch {
    return NextResponse.json({ error: "Could not load ability state." }, { status: 500 });
  }
}
