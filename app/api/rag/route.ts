import { NextRequest, NextResponse } from "next/server";
import type { ChatMessage } from "@/types/chat";
import type { RagRequest } from "@/types/rag";
import { answerWithRag, RagGenerationError, RagRequestError } from "@/lib/documents/rag";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { getOrStartSessionForMeaningfulActivity } from "@/lib/learning/sessions";
import { recordLearningEvent } from "@/lib/learning/events";
import { buildPersonalizationContext, type PersonalizationMetadata } from "@/lib/personalization/prompt-context";

// Step 25's explainability default: reported whenever fetchPersonalization was never invoked at
// all (an insufficient-evidence turn, per §21/Step 9 -- "no personalization content is even
// computed for that turn") or never resolved a concept. Never leaks raw internal state (Step 25:
// "do not expose private/internal raw learner state unnecessarily") -- every field here already
// went through lib/personalization/prompt-context.ts's own bounded, qualitative shaping.
const PERSONALIZATION_NOT_APPLIED: PersonalizationMetadata = { personalizationApplied: false, targetConceptKey: null, pedagogicalAction: null, difficulty: null, scaffoldingLevel: null, reasonCodes: null };

export const runtime = "nodejs";

/**
 * Week 3 Phase 1 addition (ARCHITECTURE.md Step 14). Records that a real, validated
 * question was asked and ensures a learning session exists for it -- purely additive evidence
 * capture. Never throws into the response path (a failure here must never change or block the
 * grounded-answer response), never touches retrieval/grounding/citation/abstention behavior, and
 * never itself emits BKT/IRT/FSRS/transfer/misconception/calibration evidence (Phase 10, Step 37:
 * "teaching interaction != scored evidence") -- a generated explanation, however personalized,
 * produces exactly this one event, same as before Phase 10.
 */
async function recordQuestionAskedEvidence(profileId: string, payload: RagRequest): Promise<void> {
  try {
    const session = await getOrStartSessionForMeaningfulActivity(profileId);
    await recordLearningEvent({
      studentId: profileId,
      sessionId: session.id,
      eventType: "QUESTION_ASKED",
      metadata: { mode: payload.mode, selfInitiated: true },
    });
  } catch (error) {
    console.error("Learning-event recording failed for a RAG question:", error);
  }
}

function normaliseHistory(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is ChatMessage =>
      !!item && typeof item === "object" &&
      (( item as ChatMessage).role === "user" || (item as ChatMessage).role === "assistant") &&
      typeof (item as ChatMessage).content === "string")
    .slice(-20)
    .map((item) => ({ id: String(item.id ?? ""), role: item.role, content: item.content, timestamp: Number(item.timestamp ?? 0) }));
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request format." }, { status: 400 });
  }

  const payload: RagRequest = {
    question: typeof body.question === "string" ? body.question : "",
    documentIds: Array.isArray(body.documentIds) ? body.documentIds.filter((id): id is string => typeof id === "string") : [],
    mode: (body.mode === "simple" || body.mode === "detailed" || body.mode === "exam") ? body.mode : "simple",
    marks: typeof body.marks === "number" ? (body.marks as RagRequest["marks"]) : undefined,
    history: normaliseHistory(body.history),
    // §21/§22, Phase 10: an OPTIONAL, explicit canonical concept key -- never inferred from the
    // question text, never used to create a concept. Client-supplied, but NOT authoritative for
    // anything beyond "which concept's personalization to compute" -- every actual learner-state
    // value (mastery, difficulty, scaffolding, pedagogical action) is still resolved entirely
    // server-side from this key, exactly like Phase 9's quiz generation resolves its own concept.
    conceptKey: typeof body.conceptKey === "string" && body.conceptKey.trim() ? body.conceptKey : undefined,
  };

  let personalizationMetadata: PersonalizationMetadata = PERSONALIZATION_NOT_APPLIED;

  try {
    const profile = await getOrCreateDefaultProfile();
    const result = await answerWithRag(payload, {
      fetchPersonalization: async () => {
        const personalization = await buildPersonalizationContext({ studentId: profile.id, conceptKey: payload.conceptKey });
        personalizationMetadata = personalization.metadata; // only ever runs when retrieval was sufficient -- see fetchPersonalization's own contract
        return personalization.prompt ?? undefined;
      },
    });
    // The request was valid and produced a grounded (or deterministically-insufficient) answer --
    // that is a real, validated question, so it counts as evidence regardless of which of the two
    // outcomes came back.
    await recordQuestionAskedEvidence(profile.id, payload);
    // Step 25: bounded, inspectable metadata only -- never raw p_mastery/theta/stability, never a
    // field beyond what lib/personalization/prompt-context.ts already computed and shaped.
    return NextResponse.json({ ...result, personalization: personalizationMetadata });
  } catch (error) {
    if (error instanceof RagRequestError) {
      // An invalid request (empty question, no documents selected, ...) never became a real
      // interaction -- no session/event is recorded for it.
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof RagGenerationError) {
      // The question itself was valid; only generation infrastructure failed -- still evidence
      // that a question was asked.
      const profile = await getOrCreateDefaultProfile();
      await recordQuestionAskedEvidence(profile.id, payload);
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    // Never surface raw database / provider errors.
    return NextResponse.json({ error: "Something went wrong while answering from your documents. Please try again." }, { status: 500 });
  }
}
