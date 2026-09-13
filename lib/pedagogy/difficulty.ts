// Combined adaptive-difficulty policy (ARCHITECTURE.md §16, "Critical Revision 13"). Location
// matches the locked architecture's own module list and phase table exactly (§29/§35: "Phase 4 |
// IRT + adaptive difficulty | ... lib/pedagogy/difficulty.ts"), not the Phase 4 task's suggested
// lib/learning/adaptive-difficulty.ts -- this is deliberately §16's policy only, a narrower and
// earlier piece than §17's full pedagogical decision engine (phase FSM + concept/action selection,
// Phase 8, not built yet). Building this file now is not "implementing the pedagogical engine
// early" -- it is exactly what this phase's own architecture entry calls for.
//
// Pure decision, impure orchestrator (the same split as everywhere else in this codebase):
// `decideDifficulty()` below is pure and takes already-resolved inputs; `getTargetDifficulty()`
// is the DB-backed wrapper that composes lib/learning/{mastery,ability,pfa}.ts's reads. Never
// calls Gemini -- there is no LLM involvement anywhere in this file.
//
// Does NOT mathematically average BKT probability and IRT theta (Step 19) -- they are read and
// applied as independent modifiers to a single discrete band, on different scales, never blended
// into one number.

import "server-only";
import { LEARNING_CONFIG } from "@/lib/learning/constants";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { probabilityCorrect, difficultyBandToB } from "@/lib/learning/irt";
import { getConcept, normalizeSubjectKey } from "@/lib/learning/concepts";
import { getMasteryState, getPracticeSignal, hasSufficientEvidence } from "@/lib/learning/mastery";
import { getAbility } from "@/lib/learning/ability";
import type { AdaptiveDifficultyDecision, AdaptiveDifficultyInput, DifficultyBand, TargetDifficultyResult } from "@/types/learning";

const RISE_EASY_TO_MEDIUM = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.DIFFICULTY_RISE_EASY_TO_MEDIUM.value;
const FALL_MEDIUM_TO_EASY = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.DIFFICULTY_FALL_MEDIUM_TO_EASY.value;
const RISE_MEDIUM_TO_HARD = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.DIFFICULTY_RISE_MEDIUM_TO_HARD.value;
const FALL_HARD_TO_MEDIUM = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.DIFFICULTY_FALL_HARD_TO_MEDIUM.value;
const IRT_SANITY_LOWER = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.IRT_SANITY_LOWER.value;
const IRT_SANITY_UPPER = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.IRT_SANITY_UPPER.value;
const MIN_EVIDENCE_FOR_ADAPTIVE = LEARNING_CONFIG.PRODUCT_POLICY_THRESHOLDS.MIN_EVIDENCE_FOR_ADAPTIVE.value;

const BAND_ORDER: DifficultyBand[] = ["easy", "medium", "hard"];
const bandIndex = (band: DifficultyBand) => BAND_ORDER.indexOf(band);
const stepUp = (band: DifficultyBand): DifficultyBand => BAND_ORDER[Math.min(BAND_ORDER.length - 1, bandIndex(band) + 1)];
const stepDown = (band: DifficultyBand): DifficultyBand => BAND_ORDER[Math.max(0, bandIndex(band) - 1)];

/**
 * §16's exact four-step combined policy, pure. `current` = `input.previousBand ?? "medium"`.
 *
 * Reason-code convention (Step 21), settled explicitly to keep this deterministic and testable:
 *  - "NO_CHANGE" whenever the final recommended band equals `current`, for any reason.
 *  - "HYSTERESIS_HOLD" specifically when the anti-oscillation ceiling (step 4) is what determined
 *    the final output -- i.e. steps 1-3 wanted to move the band by more than one step (in either
 *    direction) from `current`, and the ceiling capped it. This is distinct from "the BKT hysteresis
 *    dead-band produced no movement," which is just one path to "NO_CHANGE."
 *  - Otherwise, the code names whichever of steps 1-3 last changed the band.
 */
export function decideDifficulty(input: AdaptiveDifficultyInput): AdaptiveDifficultyDecision {
  const current = input.previousBand ?? "medium";

  if (input.bktEvidenceCount < MIN_EVIDENCE_FOR_ADAPTIVE) {
    // §16 step 1 / §7.5: below the evidence floor, pin to "medium" -- a calibration phase, never
    // an aggressive adaptation off one lucky/unlucky answer (Phase 4, Step 16).
    return { currentDifficulty: current, recommendedDifficulty: "medium", changed: current !== "medium", reasonCode: "INSUFFICIENT_EVIDENCE", evidenceSufficient: false };
  }

  // Step 1: BKT hysteresis base band.
  let band = current;
  let reasonCode: AdaptiveDifficultyDecision["reasonCode"] = "NO_CHANGE";
  if (current === "easy" && input.pMastery > RISE_EASY_TO_MEDIUM) {
    band = "medium";
    reasonCode = "MASTERY_SUPPORTS_INCREASE";
  } else if (current === "medium") {
    if (input.pMastery > RISE_MEDIUM_TO_HARD) {
      band = "hard";
      reasonCode = "MASTERY_SUPPORTS_INCREASE";
    } else if (input.pMastery < FALL_MEDIUM_TO_EASY) {
      band = "easy";
      reasonCode = "MASTERY_REQUIRES_SUPPORT";
    }
  } else if (current === "hard" && input.pMastery < FALL_HARD_TO_MEDIUM) {
    band = "medium";
    reasonCode = "MASTERY_REQUIRES_SUPPORT";
  }

  // Step 2: PFA plateau modifier -- nudge down ONE step, once, if plateaued (§8's one defined role
  // in this policy; PFA never sets theta/mastery and never picks an arbitrary band on its own).
  if (input.pfaPlateaued) {
    const nudged = stepDown(band);
    if (nudged !== band) {
      band = nudged;
      reasonCode = "PFA_PLATEAU";
    }
  }

  // Step 3: IRT sanity modifier -- ignored entirely below the evidence floor (§9.4).
  if (input.irtObservationCount >= MIN_EVIDENCE_FOR_ADAPTIVE && input.irtTheta !== null) {
    const b = difficultyBandToB(band);
    const p = probabilityCorrect(input.irtTheta, b);
    if (p < IRT_SANITY_LOWER) {
      const nudged = stepDown(band);
      if (nudged !== band) {
        band = nudged;
        reasonCode = "ABILITY_BELOW_TARGET";
      }
    } else if (p > IRT_SANITY_UPPER) {
      const nudged = stepUp(band);
      if (nudged !== band) {
        band = nudged;
        reasonCode = "ABILITY_ABOVE_TARGET";
      }
    }
  }

  // Step 4: anti-oscillation ceiling -- never move more than one band step per quiz, regardless of
  // how many of steps 1-3 fired (§16 step 4, unchanged principle from Revision 1).
  const delta = bandIndex(band) - bandIndex(current);
  if (delta > 1) {
    band = stepUp(current);
    reasonCode = "HYSTERESIS_HOLD";
  } else if (delta < -1) {
    band = stepDown(current);
    reasonCode = "HYSTERESIS_HOLD";
  }

  const changed = band !== current;
  return { currentDifficulty: current, recommendedDifficulty: band, changed, reasonCode: changed ? reasonCode : "NO_CHANGE", evidenceSufficient: true };
}

export interface DifficultyDependencies {
  supabase?: ReturnType<typeof getSupabaseAdmin>;
}

/**
 * Derives `previousBand` from the most recent QUIZ_ANSWERED event's `difficulty` metadata (Step 22:
 * prefer derivation over a new persisted column -- Phase 3 already reserved this exact metadata
 * field for this exact future use).
 */
async function derivePreviousBand(studentId: string, conceptId: string, supabase: ReturnType<typeof getSupabaseAdmin>): Promise<DifficultyBand | null> {
  const { data, error } = await supabase
    .from("learning_events")
    .select()
    .eq("student_id", studentId)
    .eq("concept_id", conceptId)
    .eq("event_type", "QUIZ_ANSWERED")
    .order("occurred_at", { ascending: false })
    .limit(1);
  if (error) throw new Error("Could not load recent quiz history.");
  const row = (data ?? [])[0] as Record<string, unknown> | undefined;
  const difficulty = (row?.metadata as { difficulty?: DifficultyBand } | undefined)?.difficulty;
  return difficulty ?? null;
}

/**
 * The Phase 9 quiz-selection contract (Step 23), defined now and consumed later. Composes
 * mastery/ability/PFA reads and the pure policy above -- generates no quiz question.
 */
export async function getTargetDifficulty(studentId: string, conceptId: string, dependencies: DifficultyDependencies = {}): Promise<TargetDifficultyResult> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const concept = await getConcept(conceptId, { supabase });
  if (!concept) throw new Error("Unknown concept.");
  const subject = normalizeSubjectKey(concept.subject);

  const [masteryState, ability, practiceSignal, previousBand] = await Promise.all([
    getMasteryState(studentId, conceptId, { supabase }),
    getAbility(studentId, subject, { supabase }),
    getPracticeSignal(studentId, conceptId, { supabase }),
    derivePreviousBand(studentId, conceptId, supabase),
  ]);

  const decision = decideDifficulty({
    previousBand,
    pMastery: masteryState?.pMastery ?? 0,
    bktEvidenceCount: masteryState?.evidenceCount ?? 0,
    irtTheta: ability?.theta ?? null,
    irtObservationCount: ability?.observationCount ?? 0,
    pfaPlateaued: practiceSignal.plateaued,
  });

  return {
    decision,
    targetItemDifficultyB: difficultyBandToB(decision.recommendedDifficulty),
    masterySummary: masteryState ? { pMastery: masteryState.pMastery, evidenceCount: masteryState.evidenceCount, evidenceSufficient: hasSufficientEvidence(masteryState) } : null,
    abilitySummary: ability ? { theta: ability.theta, observationCount: ability.observationCount } : null,
  };
}
