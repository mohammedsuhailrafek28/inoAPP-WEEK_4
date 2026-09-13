import { NextResponse } from "next/server";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { listRetentionStates } from "@/lib/learning/reviews";
import { calculateRetrievability, daysBetween, getReviewStatus, getRetentionUrgency } from "@/lib/learning/retention";
import type { RetentionState } from "@/types/learning";

export const runtime = "nodejs";

// Retrievability is preferred DERIVED, not stored as continuously-changing state (Step 14): always
// computed fresh from stability + elapsed time since last_reviewed_at, never read off a stale column.
function resolveRetrievability(state: RetentionState, now: Date): number {
  if (state.stability === null || !state.lastReviewedAt) return 0;
  return calculateRetrievability(daysBetween(new Date(state.lastReviewedAt), now), state.stability);
}

// Read-only (Step 24): there is no write route anywhere in this API surface. Retention state is
// mutated only by lib/learning/reviews.ts::applyRetentionOutcome(), called from trusted server code
// -- never from a client-facing endpoint. No client can set stability/difficulty/next_review_at/
// reps/lapses/rating.
export async function GET() {
  try {
    const profile = await getOrCreateDefaultProfile();
    const states = await listRetentionStates(profile.id);
    const now = new Date();
    return NextResponse.json({
      concepts: states.map((state) => {
        const retrievability = resolveRetrievability(state, now);
        return {
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
        };
      }),
    });
  } catch {
    return NextResponse.json({ error: "Could not load retention state." }, { status: 500 });
  }
}
