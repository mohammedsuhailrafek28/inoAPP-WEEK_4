import { NextResponse } from "next/server";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { getDueReviews } from "@/lib/learning/reviews";

export const runtime = "nodejs";

// Read-only (Step 24). This phase owns retention DUE-NESS only (Step 23) -- the list is ordered by
// most-decayed-first, not by any cross-model learning-priority score; a later pedagogy phase owns that.
export async function GET() {
  try {
    const profile = await getOrCreateDefaultProfile();
    const due = await getDueReviews(profile.id);
    return NextResponse.json({
      due: due.map((review) => ({
        conceptId: review.conceptId,
        conceptKey: review.conceptKey,
        displayName: review.displayName,
        subject: review.subject,
        retrievability: review.retrievability,
        urgency: review.urgency,
        reviewStatus: review.reviewStatus,
        nextReviewAt: review.state.nextReviewAt,
      })),
    });
  } catch {
    return NextResponse.json({ error: "Could not load due reviews." }, { status: 500 });
  }
}
