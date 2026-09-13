import { NextRequest, NextResponse } from "next/server";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { getConceptByKey } from "@/lib/learning/concepts";
import { getRetentionState } from "@/lib/learning/reviews";
import { calculateRetrievability, daysBetween, getReviewStatus, getRetentionUrgency } from "@/lib/learning/retention";

export const runtime = "nodejs";

export async function GET(_request: NextRequest, context: { params: Promise<{ conceptKey: string }> }) {
  const { conceptKey } = await context.params;
  try {
    const concept = await getConceptByKey(conceptKey);
    if (!concept) return NextResponse.json({ error: "Concept not found." }, { status: 404 });

    const profile = await getOrCreateDefaultProfile();
    const state = await getRetentionState(profile.id, concept.id);
    const now = new Date();

    if (!state) {
      return NextResponse.json({
        conceptId: concept.id,
        stability: null,
        retentionDifficulty: null,
        cardState: "new",
        reps: 0,
        lapses: 0,
        lastReviewedAt: null,
        nextReviewAt: null,
        retrievability: 0,
        urgency: getRetentionUrgency(0).level,
        reviewStatus: getReviewStatus(null, now),
      });
    }

    const retrievability = state.stability !== null && state.lastReviewedAt ? calculateRetrievability(daysBetween(new Date(state.lastReviewedAt), now), state.stability) : 0;

    return NextResponse.json({
      conceptId: state.conceptId,
      stability: state.stability,
      retentionDifficulty: state.retentionDifficulty,
      cardState: state.cardState,
      reps: state.reps,
      lapses: state.lapses,
      lastReviewedAt: state.lastReviewedAt,
      nextReviewAt: state.nextReviewAt,
      retrievability,
      urgency: getRetentionUrgency(retrievability).level,
      reviewStatus: getReviewStatus(state.nextReviewAt ? new Date(state.nextReviewAt) : null, now),
    });
  } catch {
    return NextResponse.json({ error: "Could not load retention state." }, { status: 500 });
  }
}
