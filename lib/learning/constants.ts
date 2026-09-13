// Centralized, versioned tunable-constants registry (ARCHITECTURE.md §6A, Decision 1 — LOCKED).
//
// Every tunable value used anywhere in the Week 3 learner-intelligence subsystem lives here, split
// into the three categories the architecture requires:
//   MODEL_PARAMETERS          — the mathematical model itself (BKT/IRT/FSRS/PFA internals)
//   PRODUCT_POLICY_THRESHOLDS — when the pedagogical engine acts on the model's output
//   SAFETY_CLAMPS             — numerical/pedagogical blowup guards, independent of the above
//
// No tunable value is ever inlined into a service file, and none is exposed through an API
// parameter, a client-writable field, or an admin UI (ARCHITECTURE.md §38 item 21).
//
// Phase 3 added BKT + PFA model parameters, the BKT safety clamp, the mastery-achieved threshold,
// and the sparse-evidence floor. Phase 4 added IRT's model parameters/clamp and the adaptive-
// difficulty hysteresis/sanity bands §16 locks. Phase 5 added FSRS's ported-verbatim weights/scale
// constants, the retention-urgency policy thresholds, and the stability/difficulty safety bounds.
// Phase 6 adds the prerequisite-readiness threshold, misconception activation/resolution windows,
// transfer's success/readiness thresholds, and calibration's actionability/sample-window constants.
// Phase 7 adds the scaffolding tier bounds, the autonomy trend window/thresholds, and narrative
// memory's length/similarity/capacity bounds.
//
// Versioned, not hardcoded-forever: a future tuning pass bumps LEARNING_CONFIG.version rather than
// silently editing a value in place (ARCHITECTURE.md §6A/§20). Every persisted mastery
// transition (Phase 3, `learner_state_transitions.config_version`) records this version, so a
// later config change never makes historical transitions unexplainable.

import "server-only";

export type ConstantProvenance = "PUBLISHED_ALGORITHM" | "TUTOR_MCP_CHOICE" | "OUR_CHOICE";

export interface TunableConstant<T> {
  readonly value: T;
  readonly provenance: ConstantProvenance;
  readonly rationale: string;
}

function defineConstant<T>(value: T, provenance: ConstantProvenance, rationale: string): TunableConstant<T> {
  return Object.freeze({ value, provenance, rationale });
}

export const MODEL_PARAMETERS = Object.freeze({
  // BKT (ARCHITECTURE.md §7.4) -- global fallbacks. P(L0)/P(T) are per-concept-overridable
  // via learning_concepts.default_p_l0/default_p_t (null falls back to these); P(S)/P(G) are
  // per-(concept, item type) in principle but have no per-concept override in v1 -- see §7.4.
  BKT_DEFAULT_P_L0: defineConstant(0.2, "OUR_CHOICE", "Conservative 'assume not yet known' prior, within the commonly-cited 0.1-0.3 range for Corbett & Anderson-style BKT deployments; not fitted to real data (ARCHITECTURE.md §7.4)."),
  BKT_DEFAULT_P_T: defineConstant(0.3, "OUR_CHOICE", "Within the commonly-cited BKT learning-rate range (ARCHITECTURE.md §7.4)."),
  BKT_DEFAULT_P_S_MCQ: defineConstant(0.1, "OUR_CHOICE", "No Tutor MCP equivalent -- a per-item-type split we introduce (ARCHITECTURE.md §7.4)."),
  BKT_DEFAULT_P_S_SHORT_ANSWER: defineConstant(0.15, "OUR_CHOICE", "Higher than MCQ to account for LLM-graded rubric noise (ARCHITECTURE.md §7.4)."),
  BKT_DEFAULT_P_G_MCQ: defineConstant(0.22, "OUR_CHOICE", "Approximates a 1-in-~4.5 chance guess on a typical MCQ (ARCHITECTURE.md §7.4)."),
  BKT_DEFAULT_P_G_SHORT_ANSWER: defineConstant(0.05, "OUR_CHOICE", "Near-zero blind-guess chance for free text (ARCHITECTURE.md §7.4)."),
  BKT_FORGET_WITHIN_SESSION: defineConstant(
    0.02,
    "OUR_CHOICE",
    "Tutor MCP exposes a live P(Forget) field but never mutates it at any call site the audit " +
      "found; we fix it as a small constant rather than carry unused flexibility (ARCHITECTURE.md §7.2). " +
      "This is the exact term that makes the architecture's hand-verified example (P_L=0.5, P_T=0.3, " +
      "P_Forget=0.05, P_S=0.1, P_G=0.2 -> correct gives exactly 0.8318) reproduce -- omitting it, as a " +
      "simplified 'newMastery = posterior + (1-posterior)*P(T)' formula would, does not match that " +
      "verified number and was confirmed NOT to be what's locked before implementing (Phase 3, Step 4).",
  ),
  // PFA (ARCHITECTURE.md §8) -- ported verbatim, symmetric, no intercept.
  PFA_BETA_SUCCESS: defineConstant(0.11, "TUTOR_MCP_CHOICE", "Adopted verbatim from the audited source (ARCHITECTURE.md §8)."),
  PFA_BETA_FAILURE: defineConstant(-0.11, "TUTOR_MCP_CHOICE", "Adopted verbatim from the audited source (ARCHITECTURE.md §8)."),
  // IRT (ARCHITECTURE.md §9) -- 1PL/Rasch (no discrimination parameter -- see the "IRT model
  // re-review" note at §6A/§38: nothing in this design ever consumes one).
  IRT_THETA_BOUNDS: defineConstant(
    { min: -4, max: 4 },
    "TUTOR_MCP_CHOICE",
    "The domain ability θ is clamped to, adopted verbatim (ARCHITECTURE.md §9.3). Categorized " +
      "as a model parameter (the valid range of the ability scale itself), not a safety clamp, " +
      "exactly as the locked doc's §6A table does -- SAFETY_CLAMPS below holds the *step* clamp instead.",
  ),
  IRT_BASE_PRIOR_PRECISION: defineConstant(
    1.0,
    "TUTOR_MCP_CHOICE",
    "The regularization anchor for the Newton-step update -- grows with observation_count so one " +
      "response can never saturate θ (ARCHITECTURE.md §9.3).",
  ),
  IRT_INFO_PER_OBSERVATION: defineConstant(
    0.25,
    "PUBLISHED_ALGORITHM",
    "The maximum Fisher information of a discrimination-1 2PL item is a mathematical property of " +
      "the model, not a tuned choice (ARCHITECTURE.md §9.3).",
  ),
  IRT_MAX_NEWTON_STEP: defineConstant(1.0, "TUTOR_MCP_CHOICE", "The magnitude one Newton step is clamped to before being applied to θ (ARCHITECTURE.md §9.3)."),
  IRT_ITEM_DIFFICULTY_B: defineConstant(
    { easy: -1.0, medium: 0.0, hard: 1.0 },
    "OUR_CHOICE",
    "A fixed, auditable mapping from the product difficulty label to IRT's continuous b -- no FSRS-" +
      "borrowed mapping exists in this design, since item difficulty here is an independent " +
      "per-question label, not derived from a review-scheduling difficulty (ARCHITECTURE.md §9.2).",
  ),
  // FSRS (ARCHITECTURE.md §10.2) -- ported verbatim, the Open-Spaced-Repetition project's own
  // published default parameterization, not Tutor MCP's invention (Tutor MCP itself credits this
  // project). Only the weight indices §10.2's locked formulas actually reference are named here --
  // w1/w3/w6/w7/w15-w18 (the Hard/Easy rating paths, and the difficulty-update blending term) have
  // no call site in this design: only Good/Again ratings are ever produced (§10.2's own
  // "simplification kept from the audit's advice"), and retention_difficulty is set once at a
  // card's first review via initialDifficulty() and held fixed thereafter -- §10.2 lists a
  // retrievability formula, an initial-stability/difficulty formula, a next-stability-on-success
  // formula, and a next-stability-on-lapse formula, but no "next difficulty" formula, so
  // recomputing difficulty on later reviews would be inventing an unlocked formula, not
  // implementing one (Phase 5, Step 2/4: "the architecture document wins").
  FSRS_WEIGHTS: defineConstant(
    { w0: 0.4072, w2: 3.1262, w4: 7.2102, w5: 0.5316, w8: 1.533, w9: 0.1544, w10: 1.0166, w11: 1.921, w12: 0.0854, w13: 0.2698, w14: 2.2694 },
    "PUBLISHED_ALGORITHM",
    "The Open-Spaced-Repetition project's own published default parameterization, ported verbatim (ARCHITECTURE.md §10.2/§6A).",
  ),
  FSRS_FACTOR: defineConstant(19 / 81, "PUBLISHED_ALGORITHM", "The retrievability/next-interval formulas' scale constant, ported verbatim (ARCHITECTURE.md §10.2)."),
  FSRS_DECAY: defineConstant(-0.5, "PUBLISHED_ALGORITHM", "The retrievability formula's exponent, ported verbatim (ARCHITECTURE.md §10.2)."),
  FSRS_DESIRED_RETENTION: defineConstant(0.9, "PUBLISHED_ALGORITHM", "The target recall probability the next-interval formula solves for -- a common FSRS operational convention, adopted by both Tutor MCP and us (ARCHITECTURE.md §10.2)."),
});

export const PRODUCT_POLICY_THRESHOLDS = Object.freeze({
  STALE_SESSION_MINUTES: defineConstant(
    90,
    "OUR_CHOICE",
    "Decision 2 (locked): a study session may include long PDF-reading/problem-solving gaps away " +
      "from the interaction surface. Staleness is a recovery mechanism that keeps an abandoned " +
      "session from staying 'active' forever -- it is never a precise claim about when the learner " +
      "actually stopped. See ARCHITECTURE.md §31.",
  ),
  MAX_PREREQUISITE_TRAVERSAL_DEPTH: defineConstant(
    64,
    "OUR_CHOICE",
    "Phase 2, Step 13: a safety bound on prerequisite-graph traversal (closures, topological " +
      "ordering), not a normal-use limit -- a real course's deepest prerequisite chain is expected " +
      "to be a small fraction of this. Cycle prevention (ARCHITECTURE.md §6) already keeps " +
      "the graph acyclic at edge-insert time, so this is defense-in-depth against a pathological " +
      "graph, not the primary safeguard.",
  ),
  MASTERY_ACHIEVED_THRESHOLD: defineConstant(
    0.85,
    "TUTOR_MCP_CHOICE",
    "Their unified-profile value, adopted (ARCHITECTURE.md §7.3). The 'hard' BKT mastery " +
      "verdict -- deliberately a different, higher constant than MASTERY_READY_THRESHOLD (0.70, " +
      "prerequisite-unlock gate), which is not needed until a later phase wires up readiness/gating " +
      "and is therefore not yet in this file (no premature filling).",
  ),
  MIN_EVIDENCE_FOR_ADAPTIVE: defineConstant(
    3,
    "OUR_CHOICE",
    "Below this many scored opportunities on a concept (BKT) or observations on a subject (IRT), " +
      "the estimate is provisional -- every downstream consumer (the mastery read API's 'mastered' " +
      "badge, and Phase 4's adaptive-difficulty policy/IRT sanity modifier) must not treat a sparse " +
      "posterior/theta as a confident verdict (ARCHITECTURE.md §7.5/§9.4).",
  ),
  // Adaptive difficulty hysteresis (ARCHITECTURE.md §16) -- the exact Revision 3 thresholds,
  // used verbatim, not re-derived: rise thresholds are higher than fall thresholds so a single
  // boundary-straddling answer can't flip the band back and forth.
  DIFFICULTY_RISE_EASY_TO_MEDIUM: defineConstant(0.45, "OUR_CHOICE", "§16 step 1 -- unchanged from Revision 1's original hysteresis design."),
  DIFFICULTY_FALL_MEDIUM_TO_EASY: defineConstant(0.35, "OUR_CHOICE", "§16 step 1 -- unchanged from Revision 1's original hysteresis design."),
  DIFFICULTY_RISE_MEDIUM_TO_HARD: defineConstant(0.75, "OUR_CHOICE", "§16 step 1 -- unchanged from Revision 1's original hysteresis design."),
  DIFFICULTY_FALL_HARD_TO_MEDIUM: defineConstant(0.65, "OUR_CHOICE", "§16 step 1 -- unchanged from Revision 1's original hysteresis design."),
  // IRT sanity modifier band (ARCHITECTURE.md §9.4/§16 step 3) -- distinct from the ZPD band
  // below: this one answers "is the selected band absurd given θ," nudging toward center if so.
  IRT_SANITY_LOWER: defineConstant(0.40, "OUR_CHOICE", "§9.4/§16 step 3 -- below this predicted P(correct), the chosen band is nudged one step down."),
  IRT_SANITY_UPPER: defineConstant(0.90, "OUR_CHOICE", "§9.4/§16 step 3 -- above this predicted P(correct), the chosen band is nudged one step up."),
  // The ZPD band (ARCHITECTURE.md §9.4) -- reused directly from the audited source. Not yet
  // consumed by anything in Phase 4 (question SELECTION near this band is Phase 9's quiz-generation
  // concern); recorded now so that phase needs no new constant.
  IRT_ZPD_LOWER: defineConstant(0.55, "TUTOR_MCP_CHOICE", "ARCHITECTURE.md §9.4 -- reused directly from the audited source's ZPD band."),
  IRT_ZPD_UPPER: defineConstant(0.80, "TUTOR_MCP_CHOICE", "ARCHITECTURE.md §9.4 -- reused directly from the audited source's ZPD band."),
  // §10.3's three-tier retention urgency ("reusing the same numbers as the FORGETTING alert"). A
  // real discrepancy was caught and resolved before writing code: this file's own §6A summary table
  // lists RETENTION_WARNING/RETENTION_CRITICAL as 0.40/0.30, but §10.3 -- the later, more specific,
  // explicitly "Critical Revision 4" section -- locks the actual three tiers as retrievability
  // >= 0.50 -> not urgent, [0.30, 0.50) -> WARNING, < 0.30 -> CRITICAL. Per Phase 5 Step 2 ("the
  // architecture document wins" when a summary table and a later worked section disagree, the same
  // resolution already applied to Phase 3's BKT formula and Phase 4's IRT formula), §10.3's two
  // thresholds (0.50/0.30) are implemented; the stale 0.40 is not used anywhere.
  RETENTION_URGENCY_WARNING_MAX: defineConstant(0.50, "TUTOR_MCP_CHOICE", "§10.3 -- at or above this retrievability, a review is not urgent. Below it (down to RETENTION_URGENCY_CRITICAL_MAX), the WARNING tier applies."),
  RETENTION_URGENCY_CRITICAL_MAX: defineConstant(0.30, "TUTOR_MCP_CHOICE", "§10.3 -- below this retrievability, the CRITICAL tier applies (forces SPACED_REVIEW in a later phase's pedagogical engine; not consumed by anything in Phase 5)."),
  // Phase FSM (ARCHITECTURE.md §17.1, Phase 9) -- named distinctly from
  // RETENTION_URGENCY_WARNING_MAX even though both are literally 0.50: §17.1 uses this value to
  // answer a different question ("should the subject route back to INSTRUCTION") than §10.3's urgency
  // tier ("is one concept's review non-urgent/warning/critical") -- the same numeric coincidence
  // pattern already established for TRANSFER_FAILURE_THRESHOLD vs. TRANSFER_READY_MIN_SCORE.
  RETENTION_ROUTING_THRESHOLD: defineConstant(0.50, "TUTOR_MCP_CHOICE", "§17.1 -- MAINTENANCE -> INSTRUCTION when any mastered concept's retrievability drops below this value."),
  // Prerequisite readiness (ARCHITECTURE.md §6) -- deliberately distinct from
  // MASTERY_ACHIEVED_THRESHOLD (0.85, the "fully mastered" verdict): "good enough to move on to
  // dependent material" is a different, lower bar than "fully mastered," and Tutor MCP's own
  // codebase unifying these was flagged by the audit as an unintended drift, not a design to copy.
  MASTERY_READY_THRESHOLD: defineConstant(0.70, "TUTOR_MCP_CHOICE", "§6/§7.3 -- their legacy KST-profile prerequisite-unlock value, adopted. isReadyFor(concept) requires every direct prerequisite's p_mastery >= this value."),
  // Misconceptions (ARCHITECTURE.md §11).
  MISCONCEPTION_ACTIVATION_EVIDENCE_COUNT: defineConstant(
    2,
    "TUTOR_MCP_CHOICE",
    "§11's literal lifecycle text: 'a second incorrect answer on the same (concept, tag) ... at " +
      "evidence_count >= 2, deterministically flips status -> active.' Not itself given a named-" +
      "constant token in §6A's own summary table (only MISCONCEPTION_RESOLUTION_WINDOW is listed " +
      "there), but explicit and unambiguous in §11's prose -- centralized here per Phase 6 Step 12 " +
      "rather than left as an inline literal.",
  ),
  MISCONCEPTION_RESOLUTION_WINDOW: defineConstant(3, "TUTOR_MCP_CHOICE", "§11 -- adopted directly from Tutor MCP's MisconceptionResolutionWindow. An active misconception resolves once none of the student's last 3 relevant interactions on the concept re-trigger the same tag."),
  // Transfer (ARCHITECTURE.md §12). Two distinct thresholds are both literally present in
  // the locked doc, answering two different questions -- not a drift to resolve away: TRANSFER_
  // FAILURE_THRESHOLD (from §6A's summary table) gates whether one attempt counts as a "success"
  // for the plain attempt/success counters; TRANSFER_READY_MIN_SCORE (embedded directly in §12's
  // ladder prose, never given its own named token there) is the stricter bar the readiness ladder
  // applies specifically to the *most recent* transfer attempt.
  TRANSFER_FAILURE_THRESHOLD: defineConstant(0.50, "TUTOR_MCP_CHOICE", "§6A/§12 -- a graded attempt (recall/application/transfer) counts toward its level's *Successes counter when score >= this value."),
  TRANSFER_READY_MIN_SCORE: defineConstant(0.60, "TUTOR_MCP_CHOICE", "§12's readiness-ladder prose -- the most recent transfer-level attempt must score >= this for the ladder to report 'ready', a stricter bar than the general success threshold above."),
  // Calibration (ARCHITECTURE.md §13).
  CALIBRATION_ACTIONABLE_BIAS: defineConstant(0.25, "TUTOR_MCP_CHOICE", "§13 -- isActionable(bias, sampleCount) = sampleCount >= CALIBRATION_MIN_SAMPLES AND |bias| >= this value."),
  CALIBRATION_MIN_SAMPLES: defineConstant(5, "TUTOR_MCP_CHOICE", "§13 -- the minimum resolved-sample count before any calibration state beyond INSUFFICIENT_EVIDENCE may be reported (Step 23/24's exact display gate)."),
  CALIBRATION_ROLLING_WINDOW: defineConstant(20, "TUTOR_MCP_CHOICE", "§13 -- bias = AVG(delta) over the student's most recent 20 resolved records, a simple rolling mean, not an EWMA."),
  // Scaffolding (ARCHITECTURE.md §15) -- the exact Revision 3 values ("bounds corrected in
  // this lock to match Tutor MCP's audited fade-tier values exactly" -- §6A's own provenance note
  // for SCAFFOLDING_TIER_BOUNDS; Revision 2's text had drifted to 0.35 with no stated rationale).
  SCAFFOLDING_TIER_BOUNDS: defineConstant({ highSupportMax: 0.3, lowSupportMin: 0.7 }, "TUTOR_MCP_CHOICE", "§15 -- score < 0.3 -> HIGH_SUPPORT, 0.3 <= score < 0.7 -> STANDARD, score >= 0.7 -> LOW_SUPPORT, before the trend shift."),
  // Autonomy trend (§15): needs >= 6 historical scores or defaults 'stable'; compares the mean of
  // the newest 5 vs. the prior 5.
  AUTONOMY_TREND_MIN_HISTORY: defineConstant(6, "TUTOR_MCP_CHOICE", "§15 -- fewer than 6 historical autonomy scores means there's no prior-5-vs-newest-5 comparison to make; trend defaults to 'stable'."),
  AUTONOMY_TREND_WINDOW: defineConstant(5, "TUTOR_MCP_CHOICE", "§15 -- trend compares the mean of the newest 5 scores against the mean of the prior 5."),
  AUTONOMY_TREND_DELTA: defineConstant(0.05, "TUTOR_MCP_CHOICE", "§15 -- diff > 0.05 -> improving, diff < -0.05 -> declining, otherwise stable."),
  // Narrative memory (§5.1).
  NARRATIVE_CANDIDATE_MAX_LENGTH: defineConstant(300, "TUTOR_MCP_CHOICE", "§5.1 -- 'bounded: max 300 chars, one sentence.'"),
  NARRATIVE_CORROBORATION_SIMILARITY: defineConstant(0.6, "TUTOR_MCP_CHOICE", "§5.1 -- normalized token overlap >= this promotes a pending observation to confirmed, when proposed independently in a later session. No embedding call -- a cheap string-similarity check only."),
  NARRATIVE_CONFIRMED_CAP: defineConstant(20, "TUTOR_MCP_CHOICE", "§5.1 -- confirmed narrative observations are capped at 20 per student, oldest evicted first."),
  NARRATIVE_PENDING_CAP: defineConstant(10, "TUTOR_MCP_CHOICE", "§5.1 -- pending candidates are capped at 10 per student, oldest evicted first."),
  // Memory retrieval (Phase 7, Step 26) -- not itself named in §5/§22, but the same "bound what a
  // future prompt consumer receives" principle §22 already locks for the RAG-facing learner-context
  // budget; this is the analogous cap for the narrower, not-yet-RAG-integrated retrieval contract.
  MEMORY_CONTEXT_DEFAULT_LIMIT: defineConstant(5, "OUR_CHOICE", "Default cap on recentEpisodes/relevantNarratives returned by getLearnerMemoryContext() when no caller-supplied limit is given -- prevents an unbounded history/narrative dump to any future consumer."),
  // Open Learner Model presentation (ARCHITECTURE.md §30.2, Phase 10). Named distinctly from
  // RETENTION_URGENCY_WARNING_MAX (0.50, §10.3's pedagogical-engine/urgency-tier threshold) even
  // though §30.2's own text also says "0.40" -- these are two locked sections answering two
  // different questions (is a review non-urgent/warning/critical, vs. does a concept's STUDENT-
  // FACING stage read as REVIEW_DUE), the same "both numbers are real, separately named" resolution
  // already applied to TRANSFER_FAILURE_THRESHOLD vs. TRANSFER_READY_MIN_SCORE (Phase 6).
  OLM_REVIEW_DUE_MAX: defineConstant(0.40, "TUTOR_MCP_CHOICE", "§30.2 -- deriveMasteryStage() returns REVIEW_DUE (overriding the mastery-based stages) whenever card_state != 'new' and retrievability is below this value."),
  // Bounded learner-context builder (§22, Phase 10) -- a hard character budget for the
  // personalization block injected into the RAG prompt, independent of Week 2's own 12,000-
  // character evidence budget (lib/documents/rag.ts::EVIDENCE_CHAR_BUDGET), which this file never
  // touches or competes with.
  LEARNER_CONTEXT_BUDGET: defineConstant(1500, "OUR_CHOICE", "§22 -- 'small relative to Tutor MCP's 40 KB, because ours is injected into a prompt that already carries Week 2's own 12,000-character evidence budget.'"),
  // Revision recommendations (§23, Phase 11) -- a bounded-output cap, not itself named in §23's
  // text (which only specifies the ranking formula, never a page/list size) but required by Step
  // 23's own explicit instruction ("Respect a configured maximum. Do not return every concept in
  // the database") -- centralized here rather than an inline literal, per Decision 1.
  REVISION_RECOMMENDATIONS_DEFAULT_LIMIT: defineConstant(5, "OUR_CHOICE", "Default number of revision recommendations returned when the caller doesn't specify one."),
  REVISION_RECOMMENDATIONS_MAX_LIMIT: defineConstant(20, "OUR_CHOICE", "Hard ceiling on a caller-requested limit -- prevents a client from requesting an unbounded dump of every concept in the subject."),
});

export const SAFETY_CLAMPS = Object.freeze({
  BKT_MIN_PROBABILITY: defineConstant(
    0.02,
    "OUR_CHOICE",
    "Stronger than Tutor MCP's plain [0,1] clamp, kept per Decision 1's explicit instruction. " +
      "Mathematical review (re-confirmed this phase): this clamp introduces no directional bias -- " +
      "it only prevents the posterior from reaching an exact 0 or 1, which would otherwise make the " +
      "Bayesian update's denominators degenerate into an absorbing state immune to further evidence. " +
      "(ARCHITECTURE.md §6A/§7.2)",
  ),
  BKT_MAX_PROBABILITY: defineConstant(0.98, "OUR_CHOICE", "See BKT_MIN_PROBABILITY -- the matching upper bound of the same absorbing-state guard."),
  BKT_BAYES_DENOMINATOR_FLOOR: defineConstant(1e-9, "TUTOR_MCP_CHOICE", "Anti-division-by-zero guard on the Bayesian update's denominator (ARCHITECTURE.md §7.2)."),
  IRT_NEWTON_STEP_CLAMP: defineConstant(
    { min: -1, max: 1 },
    "TUTOR_MCP_CHOICE",
    "The operative clamp applied to the raw Newton step before it moves θ (ARCHITECTURE.md " +
      "§9.3/§6A). Restates IRT_MAX_NEWTON_STEP's magnitude (1.0) as a full range under the " +
      "SAFETY_CLAMPS category, matching the locked doc's own categorization exactly.",
  ),
  FSRS_STABILITY_DIFFICULTY_FLOOR: defineConstant(
    1e-9,
    "PUBLISHED_ALGORITHM",
    "Anti-Pow(0,-k)-Infinity guard inherent to the retrievability/stability formulas, not a tuned choice -- floors stability before it is ever raised to a negative power (ARCHITECTURE.md §10.2/§6A).",
  ),
  FSRS_DIFFICULTY_BOUNDS: defineConstant({ min: 1, max: 10 }, "PUBLISHED_ALGORITHM", "The clamp initialDifficulty() applies, ported verbatim (ARCHITECTURE.md §10.2)."),
  FSRS_MIN_INTERVAL_DAYS: defineConstant(1, "PUBLISHED_ALGORITHM", "The next-interval formula's own max(1, ...) floor, ported verbatim -- a review is never scheduled zero or negative days out (ARCHITECTURE.md §10.2)."),
  CALIBRATION_RANGE: defineConstant({ min: 0, max: 1 }, "OUR_CHOICE", "Mathematical necessity, not a policy choice (ARCHITECTURE.md §6A) -- predicted/actual are both derived from bounded scales (a 1-5 Likert rating, a correctness fraction) and enforced via a DB CHECK, not tunable."),
  // Quiz generation validation gates (ARCHITECTURE.md §19, Phase 9) -- guards against a
  // badly-behaved or adversarially-steered Gemini generation blowing up storage/UI, independent of
  // the model's own math (Decision 1's SAFETY_CLAMPS category, not a product-policy threshold).
  QUIZ_MAX_FIELD_LENGTH: defineConstant(2000, "OUR_CHOICE", "§19's 'oversized fields' gate -- matches migration 012's DB CHECK bound on question_text/explanation/correct_answer exactly, enforced pre-insert so a violation is a clean validation rejection, not a DB error."),
  QUIZ_MCQ_MIN_OPTIONS: defineConstant(2, "OUR_CHOICE", "§19's 'invalid option count' gate -- an MCQ needs at least a true/false-shaped choice."),
  QUIZ_MCQ_MAX_OPTIONS: defineConstant(6, "OUR_CHOICE", "§19's 'invalid option count' gate -- generous upper bound before an MCQ stops being a reasonable single-question UI."),
});

export const LEARNING_CONFIG = Object.freeze({
  version: 1,
  MODEL_PARAMETERS,
  PRODUCT_POLICY_THRESHOLDS,
  SAFETY_CLAMPS,
});
