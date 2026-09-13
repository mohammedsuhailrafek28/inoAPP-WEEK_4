// Week 3 learner-foundation types (ARCHITECTURE.md §4, §25, §27).
// Single-user/no-login for now (Auth Decision, unchanged from Revision 1): every learner-scoped
// row still carries a stable studentId so real auth can be layered in later with no schema change.

export const EXPLANATION_STYLES = ["simple", "detailed", "exam"] as const; // mirrors Week 2's ExplanationMode
export type ExplanationStyle = (typeof EXPLANATION_STYLES)[number];

export const PREFERRED_DIFFICULTIES = ["auto", "easy", "medium", "hard"] as const;
export type PreferredDifficulty = (typeof PREFERRED_DIFFICULTIES)[number];

export const PREFERRED_PACES = ["self-paced", "standard", "accelerated"] as const;
export type PreferredPace = (typeof PREFERRED_PACES)[number];

export interface StudentProfile {
  id: string;
  displayName: string;
  academicLevel: string;
  subjects: string[];
  learningGoals: string | null;
  preferredExplanationStyle: ExplanationStyle;
  preferredDifficulty: PreferredDifficulty;
  preferredPace: PreferredPace;
  examplePreference: string | null;
  createdAt: string;
  updatedAt: string;
}

// Partial, PATCH-style input. Omitting a field leaves it unchanged; explicitly provided fields
// are validated and replace the stored value (see lib/learning/profile.ts).
export type ProfileUpdateInput = Partial<{
  displayName: string;
  academicLevel: string;
  subjects: string[];
  learningGoals: string | null;
  preferredExplanationStyle: ExplanationStyle;
  preferredDifficulty: PreferredDifficulty;
  preferredPace: PreferredPace;
  examplePreference: string | null;
}>;

export const SESSION_STATUSES = ["active", "ended"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

// ARCHITECTURE.md §31 / Decision 2 (locked): stale detection is a recovery mechanism,
// never treated as an authoritative "the learner stopped now" claim.
export const SESSION_END_REASONS = ["explicit", "superseded", "stale_timeout"] as const;
export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

export interface LearningSession {
  id: string;
  studentId: string;
  subject: string;
  status: SessionStatus;
  startedAt: string;
  lastActiveAt: string;
  endedAt: string | null;
  endReason: SessionEndReason | null;
  conceptsTouched: string[];
  summary: string | null;
}

// Full catalog per ARCHITECTURE.md §25 — the DB CHECK constraint (migration 004) allows
// every one of these so later phases never need to ALTER the constraint. Phase 1 only ever
// *emits* the subset in PHASE1_EMITTABLE_EVENT_TYPES below (see the note there).
export const LEARNING_EVENT_TYPES = [
  "SESSION_STARTED",
  "SESSION_ENDED",
  "QUESTION_ASKED",
  "EXPLANATION_VIEWED",
  "QUIZ_STARTED",
  "QUIZ_ANSWERED",
  "QUIZ_COMPLETED",
  "HINT_REQUESTED",
  "CONFIDENCE_REPORTED",
  "REVIEW_COMPLETED",
  "TRANSFER_ATTEMPTED",
  "MISCONCEPTION_OBSERVED",
] as const;
export type LearningEventType = (typeof LEARNING_EVENT_TYPES)[number];

// The event types application code is actually allowed to write so far -- extended phase by phase
// ("define the enum/type safely, but do not emit events for unimplemented features"). Every other
// value in LEARNING_EVENT_TYPES is structurally valid in the database today but has zero call
// sites until the phase that implements it lands.
//
// Phase 3 adds QUIZ_ANSWERED -- ARCHITECTURE.md §25 already names this (not a new
// "ANSWER_CORRECT"/"ANSWER_INCORRECT" pair) as the eventual single authoritative scored-outcome
// event; its `correct` boolean lives in metadata, not as a second event-type axis, so BKT and the
// future quiz engine (Phase 9) share exactly one event shape with no risk of double-counting an
// opportunity across two differently-named events for the same attempt.
//
// Phase 7 adds HINT_REQUESTED, CONFIDENCE_REPORTED, TRANSFER_ATTEMPTED, and
// MISCONCEPTION_OBSERVED -- a retrofit of a genuine Phase 6 gap found while re-reading §25 in full
// for Phase 7's autonomy formulas (which need HINT_REQUESTED for hintIndependence and
// CONFIDENCE_REPORTED's presence in the evidence log for a complete interaction history).
// TRANSFER_ATTEMPTED/MISCONCEPTION_OBSERVED are their own dedicated evidence events per §25's
// table (not QUIZ_ANSWERED reused), each carrying the specific metadata §25 names
// (`dimension`/`score`; `tag`/`proposedByLlm`) -- lib/learning/transfer.ts and
// lib/learning/misconceptions.ts now require their sourceEventId to be one of these, not any
// QUIZ_ANSWERED event. REVIEW_COMPLETED is deliberately NOT added here: §20's pipeline explicitly
// allows FSRS to trigger "for quiz answers / explicit reviews" (either), and Phase 5 already
// correctly uses the QUIZ_ANSWERED path -- there is still no live "explicit review" UI distinct
// from an ordinary quiz answer, so adding this event type now would have zero call sites.
//
// Phase 9 adds QUIZ_STARTED (§25: audit trail for why a quiz was generated -- `action`/
// `difficulty`) and QUIZ_COMPLETED (§25: session/episodic rollup trigger -- `score`), the two
// remaining §25 event types with a real call site once the quiz pipeline exists.
export const EMITTABLE_EVENT_TYPES = [
  "SESSION_STARTED",
  "SESSION_ENDED",
  "QUESTION_ASKED",
  "EXPLANATION_VIEWED",
  "QUIZ_STARTED",
  "QUIZ_ANSWERED",
  "QUIZ_COMPLETED",
  "HINT_REQUESTED",
  "CONFIDENCE_REPORTED",
  "TRANSFER_ATTEMPTED",
  "MISCONCEPTION_OBSERVED",
] as const;
export type EmittableEventType = (typeof EMITTABLE_EVENT_TYPES)[number];

export interface LearningEvent {
  id: string;
  studentId: string;
  sessionId: string | null;
  eventType: LearningEventType;
  conceptId: string | null;
  idempotencyKey: string | null;
  metadata: Record<string, unknown>;
  occurredAt: string;
  createdAt: string;
}

// --- Concept registry & prerequisite graph (ARCHITECTURE.md §6, Phase 2) --------------------

export interface LearningConcept {
  id: string;
  subject: string; // normalized via normalizeSubjectKey() -- e.g. "algorithms", "data-structures"
  conceptKey: string; // normalized via normalizeConceptKey() -- the canonical, unique identity
  displayName: string;
  aliases: string[]; // raw input strings that normalized to this same conceptKey (audit trail only)
  defaultPL0: number | null; // BKT prior override, consumed starting Phase 3 -- unused this phase
  defaultPT: number | null; // BKT learning-rate override, consumed starting Phase 3 -- unused this phase
  createdAt: string;
  updatedAt: string;
}

// A reference to a concept as supplied by a call site that may not yet have a concept id --
// e.g. a future quiz-generation or concept-extraction step. Resolving one is NEVER a bypass of
// normalization: lib/learning/concepts.ts::resolveConcept() is the only path from a reference to
// an authoritative LearningConcept, and it always runs displayName through normalizeConceptKey()
// first (Step 15 -- "LLM-derived concept suggestions later must pass normalization/validation
// before becoming authoritative"). Phase 2 does not yet call this from a chat/LLM code path; the
// boundary exists now so a later phase has somewhere correct to plug into.
export type ConceptReference = { conceptId: string } | { subject: string; displayName: string };

export interface ResolvedConceptReference {
  concept: LearningConcept;
  wasCreated: boolean;
}

// A directed edge: conceptId REQUIRES prerequisiteConceptId (prerequisiteConceptId must come first).
export interface ConceptPrerequisiteEdge {
  conceptId: string;
  prerequisiteConceptId: string;
  createdAt: string;
}

// Slim, client-safe view used inside a graph response's nested prerequisite/dependent lists --
// deliberately narrower than LearningConcept (no aliases, no BKT-prior overrides, no timestamps).
export interface ConceptGraphNode {
  id: string;
  conceptKey: string;
  displayName: string;
  subject: string;
}

export interface ConceptGraphEdge {
  conceptId: string;
  prerequisiteConceptId: string;
}

// Structural (non-mastery) prerequisite information for one concept -- see lib/learning/concepts.ts
// for why this is deliberately NOT "readiness": readiness additionally needs learner mastery of
// each prerequisite, which does not exist until Phase 3's learner_concept_state lands.
export interface StructuralPrerequisiteInfo {
  conceptId: string;
  directPrerequisites: ConceptGraphNode[];
  transitivePrerequisiteCount: number;
  depth: number; // length of the longest prerequisite chain leading to this concept
}

// Deterministic topological order of everything that must be learned before targetConceptId,
// target itself excluded (ARCHITECTURE.md Step 12's "getPrerequisiteLearningOrder").
export interface PrerequisitePath {
  targetConceptId: string;
  order: ConceptGraphNode[];
}

// --- BKT mastery & PFA practice signal (ARCHITECTURE.md §7, §8, Phase 3) -----------------

export type BktOutcome = "correct" | "incorrect";

// Item-type scoping for P(S)/P(G) (§7.4) -- Phase 3 has no live quiz engine yet (Phase 9), so
// callers that don't know the real item type may omit this and get the "mcq" defaults; it never
// influences BKT beyond selecting which slip/guess pair to use.
export type BktItemType = "mcq" | "short_answer";

export interface BktParams {
  pLearn: number; // P(T)
  pSlip: number; // P(S)
  pGuess: number; // P(G)
  pForget: number; // fixed small constant, §7.2
}

export interface BktUpdateResult {
  posterior: number; // after the Bayesian observation step, before the learning transition
  mastery: number; // after the learning transition + clamp -- the new p_mastery
}

// The authoritative evidence contract (Step 8): BKT updates ONLY from this shape, and only via
// lib/learning/mastery.ts::applyLearningOutcome(), which verifies sourceEventId against a real,
// already-persisted learning_events row before ever touching learner_concept_state.
export interface LearningOutcomeEvidence {
  studentId: string;
  conceptId: string;
  outcome: BktOutcome;
  sourceEventId: string;
  itemType?: BktItemType; // affects BKT's P(S)/P(G) selection (§7.4)
  difficulty?: "easy" | "medium" | "hard"; // stored for a later phase (IRT, Phase 4); NEVER read by BKT
}

export interface LearnerConceptState {
  studentId: string;
  conceptId: string;
  pMastery: number;
  evidenceCount: number;
  correctCount: number;
  incorrectCount: number;
  firstPracticedAt: string | null;
  lastPracticedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// One immutable, append-only audit row per applied BKT update -- the replay/audit trail (Step 11,
// Step 12). `sourceEventId` is UNIQUE at the database level: this is the actual mechanism that
// makes "the same evidence cannot update mastery twice" true even under concurrent submission,
// not just an application-level convention.
export interface LearnerStateTransition {
  id: string;
  studentId: string;
  conceptId: string;
  sourceEventId: string;
  algorithm: "bkt";
  configVersion: number;
  outcome: BktOutcome;
  masteryBefore: number;
  masteryAfter: number;
  opportunitiesBefore: number;
  opportunitiesAfter: number;
  createdAt: string;
}

// Result of applyLearningOutcome() -- a full before/after trace, not just the new state, so a
// caller (or a test) can show exactly what changed and why.
export interface LearningOutcomeResult {
  state: LearnerConceptState;
  transition: LearnerStateTransition;
  alreadyProcessed: boolean; // true when sourceEventId had already produced a transition (idempotent replay)
}

// PFA's practice signal (§8) -- deliberately NOT a second mastery probability. `pfaProbability` is
// a stagnation-detection intermediate value, not a competing estimate of "is this mastered."
export interface PracticeSignal {
  opportunities: number;
  successRate: number | null; // null when opportunities === 0 -- never a fabricated 0
  pfaProbability: number | null; // sigmoid(pfaScore) -- null when opportunities === 0
  plateaued: boolean; // true only when >=4 recent scored outcomes show a flat trend (§8)
}

// --- IRT ability & adaptive difficulty (ARCHITECTURE.md §9, §16, Phase 4) -----------------

export type IrtOutcome = BktOutcome; // same {correct, incorrect} vocabulary -- one shared evidence shape

// Product-facing difficulty label -- distinct from IRT's continuous b (§9's own "keep two concepts
// distinct" instruction). Mapped to b via LEARNING_CONFIG.MODEL_PARAMETERS.IRT_ITEM_DIFFICULTY_B.
export type DifficultyBand = "easy" | "medium" | "hard";

export interface LearnerAbility {
  studentId: string;
  subject: string; // normalized via lib/learning/concepts.ts::normalizeSubjectKey() -- never derived from arbitrary event metadata (Step 15)
  theta: number;
  observationCount: number;
  correctCount: number;
  incorrectCount: number;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  // §17.1's per-subject phase FSM + §17.2's anti-repeat state (Phase 9) -- piggybacked onto this
  // row exactly as §27 locks it ("+ §17.1's phase column"), no new table.
  phase: ConceptPhase;
  phaseChangedAt: string | null;
  lastSelectedConceptId: string | null;
  lastSelectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// The authoritative evidence contract for IRT (mirrors LearningOutcomeEvidence, Step 8). Subject is
// deliberately NOT a field here -- it is always derived server-side from `learning_concepts.subject`
// for the resolved concept, never trusted from a caller or from event metadata (Step 15).
export interface AbilityOutcomeEvidence {
  studentId: string;
  conceptId: string;
  outcome: IrtOutcome;
  sourceEventId: string;
  difficulty: DifficultyBand; // authoritative item difficulty label; maps to b -- never client-supplied (Step 8/9)
}

// One immutable, append-only audit row per applied IRT update -- learner_ability_transitions is
// its OWN table, not a repurposing of learner_state_transitions (BKT's ledger): mastery_before/
// mastery_after are a different scale and meaning than theta_before/theta_after, and the two
// algorithms must never be blended (Step 19/Phase 4 Step 12).
export interface LearnerAbilityTransition {
  id: string;
  studentId: string;
  subject: string;
  conceptId: string;
  sourceEventId: string;
  algorithm: "irt";
  configVersion: number;
  itemDifficultyB: number;
  expectedProbability: number;
  outcome: IrtOutcome;
  thetaBefore: number;
  thetaAfter: number;
  observationsBefore: number;
  observationsAfter: number;
  createdAt: string;
}

export interface AbilityOutcomeResult {
  ability: LearnerAbility;
  transition: LearnerAbilityTransition;
  alreadyProcessed: boolean;
}

// Deterministic reason codes for an adaptive-difficulty decision (Step 21) -- never Gemini-generated.
export type DifficultyReasonCode =
  | "INSUFFICIENT_EVIDENCE"
  | "MASTERY_SUPPORTS_INCREASE"
  | "MASTERY_REQUIRES_SUPPORT"
  | "PFA_PLATEAU"
  | "ABILITY_ABOVE_TARGET"
  | "ABILITY_BELOW_TARGET"
  | "HYSTERESIS_HOLD"
  | "NO_CHANGE";

// Pure policy input (lib/pedagogy/difficulty.ts) -- everything the §16 combined policy needs,
// already resolved by the caller. `previousBand` is derived from the most recent QUIZ_ANSWERED
// event's `difficulty` metadata (Step 22: prefer derivation over a new persisted column).
export interface AdaptiveDifficultyInput {
  previousBand: DifficultyBand | null; // null = no history yet -> treated as "medium"
  pMastery: number;
  bktEvidenceCount: number;
  irtTheta: number | null; // null = no ability observations yet for this subject
  irtObservationCount: number;
  pfaPlateaued: boolean;
}

export interface AdaptiveDifficultyDecision {
  currentDifficulty: DifficultyBand;
  recommendedDifficulty: DifficultyBand;
  changed: boolean;
  reasonCode: DifficultyReasonCode;
  evidenceSufficient: boolean;
}

// The Phase 9 quiz-selection contract (Step 23) -- defined now, consumed later. No quiz question is
// generated here; this only recommends WHAT difficulty the next one should target.
export interface TargetDifficultyResult {
  decision: AdaptiveDifficultyDecision;
  targetItemDifficultyB: number;
  masterySummary: { pMastery: number; evidenceCount: number; evidenceSufficient: boolean } | null;
  abilitySummary: { theta: number; observationCount: number } | null;
}

// --- Retention & review scheduling (ARCHITECTURE.md §10, Phase 5) -------------------------
//
// A RETENTION/SCHEDULING model, not another mastery model. A concept can simultaneously have high
// BKT mastery and a due FSRS review -- that means "evidence suggests the concept was learned, but
// memory reinforcement is due," never "reduce BKT mastery because the review date passed" (§10's
// explicit BKT-vs-FSRS boundary). Nothing in this file's state is ever averaged with p_mastery or
// theta, and nothing in lib/learning/{bkt,mastery,irt,ability}.ts ever reads a retention field.

// FSRS's own rating vocabulary is 4-valued (Again/Hard/Good/Easy); this design deliberately only
// ever produces two (§10.2's "simplification kept from the audit's advice") -- Hard/Easy have no
// call site anywhere, so they are not part of this type at all (not "supported but unused").
export type RetentionRating = "again" | "good";

// FSRS's own card-state machine (§10.1) -- distinct from the six-stage OLM enum (a later phase,
// mastery-facing) and from ReviewStatus below (a derived due-ness query concern, not this persisted
// state-machine concern). "new" is never actually persisted by this phase's write path (Step 13:
// retention state is only created on a real first review) -- it exists in the enum/DB CHECK for
// schema completeness matching §10.1 exactly, the same "define safely, no call site yet" pattern
// LEARNING_EVENT_TYPES already uses for events beyond EMITTABLE_EVENT_TYPES.
export const CARD_STATES = ["new", "learning", "review", "relearning"] as const;
export type CardState = (typeof CARD_STATES)[number];

// Retention fields live directly on learner_concept_state (§10.1's explicit "(in
// learner_concept_state)"), NOT a new learner_retention_state table as a task-prompt suggestion
// implied -- resolved in favor of the architecture, the same way Phase 3/4 resolved analogous
// naming/location conflicts. This type is a read projection of exactly those columns.
export interface RetentionState {
  studentId: string;
  conceptId: string;
  stability: number | null; // null until the first authoritative review (Step 13)
  retentionDifficulty: number | null; // named distinctly from IRT's `b` and the quiz difficulty enum -- three different "difficulty" concepts (§10.1)
  cardState: CardState;
  reps: number; // total applied reviews -- also this row's own CAS counter, independent of BKT's evidence_count on the same row
  lapses: number; // count of review -> relearning transitions only (Step 12), not every "again"
  lastReviewedAt: string | null;
  nextReviewAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// The authoritative evidence contract for FSRS (mirrors LearningOutcomeEvidence/
// AbilityOutcomeEvidence). `rating` is never accepted from a caller -- it is always derived
// server-side from `outcome` via the locked 1:1 mapping (correct -> good, incorrect -> again,
// §10.2), the same shared QUIZ_ANSWERED evidence BKT and IRT already consume (Step 9/10).
export interface RetentionOutcomeEvidence {
  studentId: string;
  conceptId: string;
  outcome: BktOutcome;
  sourceEventId: string;
}

// One immutable, append-only audit row per applied FSRS review -- learner_retention_transitions is
// its OWN dedicated ledger (not a repurposing of learner_state_transitions or
// learner_ability_transitions), with its own independent UNIQUE(source_event_id) boundary (Step 11/
// 12): the same QUIZ_ANSWERED event can independently produce exactly one BKT, one IRT, and one
// FSRS transition.
export interface LearnerRetentionTransition {
  id: string;
  studentId: string;
  conceptId: string;
  sourceEventId: string;
  algorithm: "fsrs";
  configVersion: number;
  rating: RetentionRating;
  reviewedAt: string;
  elapsedDays: number; // 0 for a card's first-ever review -- there is no prior review to elapse from
  retrievabilityBefore: number | null; // null only for a first-ever review (Step 12)
  stabilityBefore: number | null;
  stabilityAfter: number;
  difficultyBefore: number | null;
  difficultyAfter: number;
  cardStateBefore: CardState;
  cardStateAfter: CardState;
  lapsed: boolean; // true only for a genuine review -> relearning transition
  nextReviewAt: string;
  createdAt: string;
}

export interface RetentionOutcomeResult {
  state: RetentionState;
  transition: LearnerRetentionTransition;
  alreadyProcessed: boolean;
}

// getReviewStatus()'s due-ness vocabulary (Step 16) -- deliberately NOT the six-stage OLM enum;
// this is retention-facing and narrower, and owns only due-ness, never overall learning priority
// (Step 23 -- that ranking is a later pedagogy-phase concern).
export type ReviewStatus = "not_started" | "scheduled" | "due" | "overdue";

// §10.3's three-tier retention urgency, reusing the FORGETTING alert's own numbers.
export type RetentionUrgencyLevel = "ok" | "warning" | "critical";

export interface RetentionUrgency {
  retrievability: number;
  level: RetentionUrgencyLevel;
}

// getDueReviews()'s contract (Step 23): this phase owns retention DUE-NESS only, never overall
// learning priority -- no BKT/PFA/IRT ranking is mixed in here.
export interface DueReview {
  conceptId: string;
  conceptKey: string;
  displayName: string;
  subject: string;
  state: RetentionState;
  retrievability: number;
  urgency: RetentionUrgencyLevel;
  reviewStatus: ReviewStatus;
}

// --- Prerequisite readiness (ARCHITECTURE.md §6, Phase 6) ---------------------------------
//
// Learner-specific readiness, distinct from Phase 2's structural prerequisite info: structure +
// learner BKT mastery + evidence sufficiency. Never derived from IRT theta or FSRS retrievability
// (Step 4/5) -- BKT p_mastery is the sole authoritative prerequisite-knowledge signal.

// Per-prerequisite verdict. "review_due" is additive information, never a downgrade of "ready" --
// high mastery + a due review means "learned, but reinforcement is due," not "unmastered" (Step 5).
export type PrerequisiteReadinessStatus = "ready" | "ready_but_review_due" | "insufficient_evidence" | "not_mastered" | "no_evidence";

export type PrerequisiteBlockerReasonCode =
  | "PREREQUISITE_NOT_MASTERED"
  | "PREREQUISITE_EVIDENCE_INSUFFICIENT"
  | "PREREQUISITE_NO_EVIDENCE";

export interface PrerequisiteReadinessDetail {
  conceptId: string;
  conceptKey: string;
  displayName: string;
  pMastery: number | null; // null when the student has no BKT evidence on this prerequisite at all
  evidenceCount: number;
  evidenceSufficient: boolean;
  status: PrerequisiteReadinessStatus;
  reviewStatus: ReviewStatus | null; // null when there is no retention state yet (Step 13's "no premature state")
  blockerReasonCode: PrerequisiteBlockerReasonCode | null; // null when status is "ready" or "ready_but_review_due"
}

// getPrerequisiteReadiness()'s full contract (Step 6/7) -- structured enough for a future
// pedagogical engine to pick a remediation target, without this phase choosing one itself.
export interface PrerequisiteReadinessResult {
  targetConceptId: string;
  targetConceptKey: string;
  directPrerequisites: PrerequisiteReadinessDetail[];
  ready: boolean; // true only when every direct prerequisite is "ready" or "ready_but_review_due"
  blockers: PrerequisiteReadinessDetail[]; // the subset of directPrerequisites that are NOT ready, in deterministic remediation order
  remediationOrder: ConceptGraphNode[]; // Phase 2's deterministic topological learning order, restricted to blockers' ancestor closure
}

// --- Misconceptions (ARCHITECTURE.md §11, Phase 6) ----------------------------------------
//
// Evidence-backed only. Gemini may propose {tag, description} as a candidate; it never sets
// `status`/`evidence_count` directly (§32's authority table) -- lib/learning/misconceptions.ts's
// recordEvidence() is the sole writer.

export const MISCONCEPTION_STATUSES = ["candidate", "active", "resolved"] as const;
export type MisconceptionStatus = (typeof MISCONCEPTION_STATUSES)[number];

export interface Misconception {
  id: string;
  studentId: string;
  conceptId: string;
  tag: string; // normalized machine-stable key, e.g. "off_by_one_boundary" -- never free text
  description: string; // one sentence, llm_observed (Step 10's "bounded explanation text")
  status: MisconceptionStatus;
  evidenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

// The authoritative evidence contract (Step 11): incorrect ≠ misconception automatically. A caller
// must supply a SPECIFIC proposed tag (from Gemini's structured output, in a later phase's live
// quiz-grading pipeline; a trusted internal pathway stands in for it here, exactly like Phase 3's
// recordScoredOutcome() stood in for a live quiz UI) -- never inferred from "incorrect" alone.
export interface MisconceptionEvidenceInput {
  studentId: string;
  conceptId: string;
  tag: string;
  description: string;
  sourceEventId: string;
}

export interface MisconceptionEvidenceTransition {
  id: string;
  studentId: string;
  conceptId: string;
  tag: string;
  sourceEventId: string;
  algorithm: "misconception";
  configVersion: number;
  description: string;
  statusBefore: MisconceptionStatus | null; // null only when this evidence created a brand-new candidate
  statusAfter: MisconceptionStatus;
  evidenceCountBefore: number;
  evidenceCountAfter: number;
  createdAt: string;
}

export interface MisconceptionEvidenceResult {
  misconception: Misconception;
  transition: MisconceptionEvidenceTransition;
  alreadyProcessed: boolean;
}

// --- Transfer (ARCHITECTURE.md §12, Phase 6) ----------------------------------------------
//
// RECALL/APPLICATION/TRANSFER -- not another mastery probability. Counters live on
// learner_concept_state (§27); the readiness ladder is recomputed fresh from them every call, never
// ratcheted/persisted (§12: "a fresh transfer failure can move a concept back ... immediately").

export const TRANSFER_LEVELS = ["recall", "application", "transfer"] as const;
export type TransferLevel = (typeof TRANSFER_LEVELS)[number];

// The authoritative evidence contract. `level` is a trusted, server-supplied label on the same
// QUIZ_ANSWERED evidence shape BKT/IRT/FSRS already consume -- never client-declared ("this was a
// transfer question," Step 16). `score` is a continuous 0..1 grade (§12's readiness ladder compares
// against a raw score, not a boolean) -- a plain MCQ recall evidence caller passes 1/0 for
// correct/incorrect; short-answer/transfer evidence may pass a real rubric score once a later
// phase's grading pipeline exists.
export interface TransferEvidenceInput {
  studentId: string;
  conceptId: string;
  level: TransferLevel;
  score: number; // 0..1
  sourceEventId: string;
  evidenceTrust?: "deterministic" | "llm_graded"; // §32 -- llm_graded evidence still counts, but is labeled
}

export interface TransferCounters {
  recallAttempts: number;
  recallSuccesses: number;
  applicationAttempts: number;
  applicationSuccesses: number;
  transferAttempts: number;
  transferSuccesses: number;
}

// §12's exact 3-state ladder, recomputed fresh -- not the task prompt's illustrative
// NO_TRANSFER_EVIDENCE/EMERGING_TRANSFER/DEMONSTRATED_TRANSFER names, which are examples only; the
// architecture's own literal names are used per "the architecture document wins."
export type TransferReadiness = "not_attempted" | "attempted" | "ready";

export interface TransferSignal {
  studentId: string;
  conceptId: string;
  counters: TransferCounters;
  mostRecentTransferScore: number | null; // null when transferAttempts === 0
  readiness: TransferReadiness;
}

export interface TransferEvidenceTransition {
  id: string;
  studentId: string;
  conceptId: string;
  sourceEventId: string;
  algorithm: "transfer";
  configVersion: number;
  level: TransferLevel;
  score: number;
  success: boolean; // score >= TRANSFER_FAILURE_THRESHOLD
  evidenceTrust: "deterministic" | "llm_graded";
  createdAt: string;
}

export interface TransferEvidenceResult {
  counters: TransferCounters;
  transition: TransferEvidenceTransition;
  alreadyProcessed: boolean;
}

// --- Calibration (ARCHITECTURE.md §13, Phase 6) --------------------------------------------
//
// Confidence vs. actual correctness. NOT mastery, NOT ability, NOT full metacognition (Step 20/25).
// The one deliberate exception to "evidence is append-only": a calibration_records row is opened
// (confidence given before answering) then resolved once (actual outcome known) -- a real mutation,
// documented explicitly as the sole exception, not a precedent for mutating anything else.

// A 1-5 Likert self-rating, converted to predicted = (rating-1)/4 -- never a raw 0..1 float and
// never a LOW/MEDIUM/HIGH categorical from the caller (§13's exact representation).
export type ConfidenceRating = 1 | 2 | 3 | 4 | 5;

export interface CalibrationRecord {
  id: string;
  studentId: string;
  conceptId: string | null;
  predicted: number; // (rating-1)/4, set at open time
  actual: number | null; // null until resolved
  delta: number | null; // predicted - actual, signed; null until resolved
  sourceEventId: string | null; // null until resolved
  createdAt: string;
  resolvedAt: string | null;
}

export interface OpenCalibrationPredictionInput {
  studentId: string;
  conceptId: string;
  rating: ConfidenceRating;
}

export interface ResolveCalibrationPredictionInput {
  studentId: string;
  conceptId: string;
  sourceEventId: string;
}

export type CalibrationState = "insufficient_evidence" | "well_calibrated" | "overconfident" | "underconfident";

export interface CalibrationSignal {
  studentId: string;
  sampleCount: number; // resolved records considered (up to CALIBRATION_ROLLING_WINDOW)
  bias: number | null; // AVG(delta), null when sampleCount === 0
  actionable: boolean; // isActionable(bias, sampleCount) -- §13's exact predicate
  state: CalibrationState;
}

// --- Autonomy / Scaffolding (ARCHITECTURE.md §15, Phase 7) --------------------------------
//
// "How independently can this learner currently work?" -- NOT intelligence, mastery, confidence,
// ability, or personality. §15 explicitly DOES define one weighted average (unlike every other
// subsystem in this codebase, which deliberately never averages signals) -- this is the one locked
// exception to "no score soup," not a precedent for inventing more of them elsewhere.

export interface AutonomyComponents {
  initiativeRate: number; // self-initiated interactions / total interactions, per session, averaged
  calibrationAccuracy: number; // 1 - min(|calibrationBias|, 1)
  hintIndependence: number; // 1 - min(hintsOnMasteredConcepts / totalOnMasteredConcepts, 1)
  proactiveReviewRate: number; // reviews completed before FSRS's next_review_at / total reviews
}

export type AutonomyTrend = "improving" | "declining" | "stable";

export interface AutonomySnapshot {
  studentId: string;
  score: number; // §15's four-component average, the ONE locked exception to "no score soup"
  components: AutonomyComponents;
  trend: AutonomyTrend; // "stable" when fewer than AUTONOMY_TREND_MIN_HISTORY historical scores exist
  historicalScoreCount: number;
}

// §15's exact three tiers (bounds corrected in the Revision 3 lock -- ARCHITECTURE.md §6A's
// SCAFFOLDING_TIER_BOUNDS provenance entry), shifted by one tier in the trend's direction.
export const SCAFFOLDING_LEVELS = ["HIGH_SUPPORT", "STANDARD", "LOW_SUPPORT"] as const;
export type ScaffoldingLevel = (typeof SCAFFOLDING_LEVELS)[number];

export type ScaffoldingReasonCode =
  | "INSUFFICIENT_EVIDENCE" // fewer than MIN_EVIDENCE_FOR_ADAPTIVE total interactions to compute a meaningful score
  | "AUTONOMY_LOW"
  | "AUTONOMY_STANDARD"
  | "AUTONOMY_HIGH"
  | "TREND_SHIFTED_UP" // trend improving -> shifted one tier toward LOW_SUPPORT
  | "TREND_SHIFTED_DOWN"; // trend declining -> shifted one tier toward HIGH_SUPPORT

export interface ScaffoldingDecision {
  level: ScaffoldingLevel;
  baseLevel: ScaffoldingLevel; // before the trend shift -- kept for interpretability (Step 6: "each reason should remain interpretable")
  reasonCodes: ScaffoldingReasonCode[];
  evidenceSufficient: boolean;
  autonomy: AutonomySnapshot | null; // null only when evidenceSufficient is false
}

// --- Episodic memory (ARCHITECTURE.md §5 Layer D, Phase 7) --------------------------------
//
// Lives on learning_sessions itself (concepts_touched + summary) -- NOT a new table. "Concrete
// learning history," grounded in authoritative events, never a raw transcript dump and never
// free-form LLM fact invention (Step 11/12).

export interface SessionEpisode {
  sessionId: string;
  studentId: string;
  subject: string;
  startedAt: string;
  endedAt: string | null;
  conceptsTouched: string[]; // concept ids, deterministically derived from this session's own learning_events
  scoredAttempts: number; // QUIZ_ANSWERED count this session
  correctAttempts: number;
  hasMeaningfulEvidence: boolean; // Step 23's empty-session gate -- false for a session with zero scored/concept-scoped evidence
  summary: string | null; // the llm_observed recap, set once via recordSessionRecap()
}

// --- Narrative memory (ARCHITECTURE.md §5 Layer E / §5.1, Phase 7) ------------------------
//
// A compact, longitudinal, NON-authoritative interpretation. Corroboration (not a single LLM
// utterance) is the only way a candidate becomes confirmed -- deterministic, §5.1.

export const NARRATIVE_MEMORY_STATUSES = ["pending", "confirmed"] as const;
export type NarrativeMemoryStatus = (typeof NARRATIVE_MEMORY_STATUSES)[number];

export interface NarrativeMemory {
  id: string;
  studentId: string;
  sessionId: string; // the session this observation was proposed in -- needed for §5.1's "a LATER session" corroboration check
  content: string; // <= NARRATIVE_CANDIDATE_MAX_LENGTH (300) chars, one sentence
  status: NarrativeMemoryStatus;
  corroboratedBy: string | null; // the confirming (later-session) narrative_memories.id, once confirmed
  createdAt: string;
}

export interface ProposeNarrativeMemoryInput {
  studentId: string;
  sessionId: string;
  content: string;
}

// --- Memory retrieval contract (Phase 7, Step 24) -- future pedagogy/personalized-RAG consumer --
//
// Deterministic filters only (same concept / prerequisite concepts / same subject / recent
// sessions) -- no vector embeddings for learner memory (Step 25): the RAG vector DB is for source
// documents, not a second retrieval system for this. NOT integrated into RAG in this phase.

export interface LearnerMemoryContextQuery {
  studentId: string;
  conceptId?: string;
  subject?: string;
  sessionId?: string;
  limit?: number; // caps recentEpisodes and relevantNarratives independently; see MEMORY_CONTEXT_DEFAULT_LIMIT
}

export interface LearnerMemoryContext {
  studentId: string;
  recentEpisodes: SessionEpisode[]; // most recent first, bounded by `limit`
  relevantNarratives: NarrativeMemory[]; // confirmed only, bounded by `limit`
  activeMisconceptions: Misconception[]; // scoped to conceptId when provided
  scaffolding: ScaffoldingDecision;
}

// --- Pedagogical decision engine (ARCHITECTURE.md §17, Phase 8) ---------------------------
//
// Decides WHICH concept and WHICH action -- never HOW to teach it (§17.4). Scope note: §17 as a
// whole covers three pieces -- the per-subject phase FSM (§17.1) and phase-dispatched multi-concept
// selection (§17.2), both of which need "concepts in the currently selected documents" (a Week 2
// RAG-side notion with no server-persisted per-learner state until Phase 10's personalized-RAG
// integration), and the action cascade for an ALREADY-CHOSEN concept (§17.3), which needs no such
// input. Every one of this phase's own task steps (4, 5, 8-20, 22, 29-36) is framed around "given a
// target concept, decide the action" -- getNextLearningAction(studentId, conceptId) takes a concept
// as a required input, never "pick one for me." Phase 8 therefore implements §17.3 (the action
// cascade) in full; §17.1/§17.2 (phase FSM + multi-concept selection) are deferred to Phase 10,
// which is where "currently selected documents" first becomes real, queryable state.

// §17.3's exact 9-action controlled enum (row 9, HINT, is "always available, not part of the
// cascade" -- included for type completeness since it is a real, named action the architecture
// defines, but the cascade itself never produces it as an output).
export const PEDAGOGICAL_ACTIONS = ["SPACED_REVIEW", "PREREQUISITE_REMEDIATION", "EXPLAIN", "TRANSFER_CHALLENGE", "DEEPEN", "SIMPLIFY", "QUIZ", "HINT", "CONTINUE"] as const;
export type PedagogicalAction = (typeof PEDAGOGICAL_ACTIONS)[number];

// One reason code per cascade row (§17.3's numbering, restated for readability) -- not itself a
// literal string the architecture names (unlike e.g. misconception status or transfer readiness),
// so these are this phase's own deterministic naming, kept 1:1 with the locked row semantics.
export type PedagogicalReasonCode =
  | "RETENTION_CRITICAL_ON_MASTERED" // row 1 -- SPACED_REVIEW
  | "PREREQUISITE_BLOCKED" // row 2 -- PREREQUISITE_REMEDIATION
  | "ACTIVE_MISCONCEPTION" // row 3 -- EXPLAIN (focus: misconception)
  | "INSUFFICIENT_EVIDENCE" // row 4 -- EXPLAIN (general)
  | "TRANSFER_ELIGIBLE" // row 5 -- TRANSFER_CHALLENGE
  | "TRANSFER_DEMONSTRATED" // row 6 -- DEEPEN
  | "RECENT_ATTEMPT_INCORRECT" // row 7 -- SIMPLIFY
  | "PRACTICE_BAND" // row 8 -- QUIZ (also the cascade's total fallback -- see select-action.ts)
  | "NO_ACTIVE_CONCEPT"; // row 10 -- CONTINUE (only reachable when no target concept is given at all)

// EXPLAIN's one piece of action-specific metadata (§17.3 row 3: "with focus: 'misconception',
// naming the tag"). Every other action has no such payload.
export interface ExplainFocus {
  focus: "misconception";
  tag: string;
}

// The already-resolved signals the pure cascade consumes -- deliberately NOT including IRT theta,
// PFA plateau, or raw calibration bias directly (Step 7/12/15): those are pre-baked into
// `difficulty`/`scaffoldingLevel` by the existing Phase 4/7 services, reused here, never
// recomputed. Memory is deliberately NOT a field on this type at all (Step 16) -- the strongest
// possible non-authority guarantee is that the pure decision logic never even receives it.
//
// Retention is carried as its own RAW fields (stability + lastReviewedAt), not a pre-resolved
// retrievability number -- Step 26 is explicit that "retention due-ness is explicitly evaluated
// against an injected authoritative `now`," so that evaluation belongs inside the pure engine
// itself (still pure: calculateRetrievability()/daysBetween() are pure functions, no I/O), not
// pre-computed by the caller. This is the one place `now` genuinely matters to the cascade.
export interface PedagogicalDecisionInput {
  targetConceptId: string;
  targetConceptKey: string;
  readiness: PrerequisiteReadinessResult; // Phase 6 -- tells the cascade both "is it blocked" and "which prerequisite to target"
  pMastery: number | null; // null = no BKT evidence at all yet
  evidenceCount: number;
  hasDiverseEvidence: boolean; // >=2 distinct item types (mcq/short_answer) answered correctly on this concept (§12's exact "diverse" definition)
  mostRecentAttemptCorrect: boolean | null; // null = never attempted
  stability: number | null; // FSRS stability -- null = no retention state yet
  lastReviewedAt: string | null; // FSRS's own last_reviewed_at -- null = no retention state yet (always null exactly when stability is)
  activeMisconceptions: Misconception[]; // already filtered to this concept AND status === 'active' -- a candidate or resolved one must never reach this field
  transferReadiness: TransferReadiness;
  difficultyDecision: AdaptiveDifficultyDecision; // Phase 4, reused verbatim
  scaffolding: ScaffoldingDecision; // Phase 7, reused verbatim
}

export interface PedagogicalSupportingSignals {
  pMastery: number | null;
  evidenceCount: number;
  evidenceSufficient: boolean;
  retrievability: number | null;
  reviewDue: boolean; // retrievability !== null && retrievability < RETENTION_URGENCY_CRITICAL_MAX, on an already-mastered concept
  prerequisiteBlocked: boolean;
  activeMisconceptionCount: number;
  transferReadiness: TransferReadiness;
  difficulty: DifficultyBand;
  scaffoldingLevel: ScaffoldingLevel;
}

export interface PedagogicalDecision {
  action: PedagogicalAction;
  targetConceptId: string; // the prerequisite's id when action === 'PREREQUISITE_REMEDIATION', otherwise the original target
  targetConceptKey: string;
  difficulty: DifficultyBand;
  scaffoldingLevel: ScaffoldingLevel;
  reasonCodes: PedagogicalReasonCode[];
  evidenceSufficient: boolean;
  supportingSignals: PedagogicalSupportingSignals;
  explain: ExplainFocus | null; // non-null only for action === 'EXPLAIN' with an active misconception (row 3)
}

// The Step 16/36 non-authority contract: episodic/narrative memory attached to a decision response
// is structurally kept OUTSIDE the pure decision's own input/output (see PedagogicalDecisionInput's
// header comment) and always labeled this way at the response boundary -- never merged into
// `PedagogicalDecision` itself, so nothing downstream can mistake it for an authoritative signal.
export interface NonAuthoritativeMemoryContext {
  recentEpisodes: SessionEpisode[];
  relevantNarratives: NarrativeMemory[];
}

export interface NextLearningActionResult {
  decision: PedagogicalDecision;
  nonAuthoritativeContext: NonAuthoritativeMemoryContext;
}

// --- Phase FSM & concept selection (ARCHITECTURE.md §17.1/§17.2, Phase 9) ------------------
//
// Deferred out of Phase 8's scope (see PedagogicalDecisionInput's header comment above) because
// nothing in Phase 8's own task steps needed "pick a concept for me" -- every step took a caller-
// supplied target concept. Phase 9's quiz-generation contract breaks that: ARCHITECTURE.md
// §28 locks `/api/quiz/generate` to internally call `/api/learning/next-activity`, a *subject*-
// scoped endpoint with no client-supplied concept at all, which cannot be built on Phase 8's
// concept-given getNextLearningAction() alone. This phase builds the two deferred pieces
// (lib/pedagogy/phase.ts, lib/pedagogy/select-concept.ts) and composes them with the existing
// §17.3 cascade into lib/pedagogy/select.ts::selectNextActivity(), matching §17/§29's exact module
// list.
//
// Documented simplification: §17.2's relevance(c) formula distinguishes concepts "in the currently
// selected documents" (relevance 1.0) from others (0.3) -- but no document<->concept mapping exists
// anywhere in the schema (learning_concepts has no document_id/FK, and Week 2's `documents` table
// has no concept linkage). Building that mapping is exactly Phase 10's "personalized RAG
// integration" (the architecture's own §17.2 note that this is "a Week 2 RAG-side notion with no
// server-persisted per-learner state until Phase 10"). Rather than inventing an unrequested
// document-tagging feature, relevance(c) = 1.0 uniformly for every concept in the requested subject
// in this phase -- the phase FSM's coverage rule and the argmax/least-evidence formulas are still
// implemented exactly as locked, just without the per-document weighting term until Phase 10 makes
// document<->concept linkage real, queryable state.
export const CONCEPT_PHASES = ["DIAGNOSTIC", "INSTRUCTION", "MAINTENANCE"] as const;
export type ConceptPhase = (typeof CONCEPT_PHASES)[number];

export type ConceptSelectionReasonCode =
  | "PRIORITY_RETENTION_CRITICAL" // §17.2 override 1
  | "PRIORITY_ACTIVE_MISCONCEPTION" // §17.2 override 2
  | "PHASE_DIAGNOSTIC_LEAST_EVIDENCE"
  | "PHASE_INSTRUCTION_ARGMAX"
  | "PHASE_MAINTENANCE_ARGMAX"
  | "NO_CONCEPTS_AVAILABLE"; // the subject has zero registered concepts

export interface ConceptSelectionResult {
  conceptId: string | null; // null only when reasonCode === NO_CONCEPTS_AVAILABLE
  conceptKey: string | null;
  displayName: string | null;
  reasonCode: ConceptSelectionReasonCode;
}

export interface NextActivityResult {
  phase: ConceptPhase;
  conceptSelection: ConceptSelectionReasonCode;
  decision: PedagogicalDecision | null; // null only when reasonCode === NO_CONCEPTS_AVAILABLE
  nonAuthoritativeContext: NonAuthoritativeMemoryContext;
}

// --- Quiz architecture (ARCHITECTURE.md §18/§19/§20, Phase 9) ------------------------------
//
// Question types are locked to BktItemType ("mcq" | "short_answer") -- the architecture never
// widens the quiz item-type enum beyond what BKT/PFA's own P(S)/P(G) split already names (§7.4),
// so reusing that type directly IS "the architecture-locked types," not a second parallel enum.
export type QuestionType = BktItemType;

export type QuizStatus = "in_progress" | "submitted" | "abandoned";

// The subset of §17.3's action cascade that may trigger quiz generation (§18's own diagram:
// "only when action ∈ {QUIZ, TRANSFER_CHALLENGE, SPACED_REVIEW, PREREQUISITE_REMEDIATION}").
export const QUIZ_ELIGIBLE_ACTIONS = ["QUIZ", "TRANSFER_CHALLENGE", "SPACED_REVIEW", "PREREQUISITE_REMEDIATION"] as const;
export type QuizEligibleAction = (typeof QUIZ_ELIGIBLE_ACTIONS)[number];

export interface QuizCitation {
  citationId: string;
  documentId: string;
  chunkId: string;
  filename: string;
  pageNumber: number;
}

// The raw shape Gemini's structured-generation call is asked to produce -- untrusted until
// lib/quiz/validate.ts's gates run (§19). `sourceLabels` mirrors Week 2's own [S#] citation
// contract (lib/documents/citations.ts) so provenance is reconstructed server-side from the SAME
// labeled-evidence map retrieval already built, never a Gemini-authored citation string (Step 12).
export interface GeneratedQuizQuestion {
  questionType: QuestionType;
  questionText: string;
  options?: string[]; // mcq only
  correctAnswer: string; // mcq: must equal one of `options` verbatim; short_answer: reference/rubric answer, never sent to the client
  explanation: string;
  sourceLabels: string[]; // e.g. ["S1","S2"] -- validated against the labeled evidence map, never trusted blindly
  transferDimension?: TransferLevel; // defaults applied server-side if omitted (§18); validated against question_type/action context, never trusted blindly if present
}

export type QuizValidationRejectionReason =
  | "MALFORMED_OUTPUT"
  | "UNSUPPORTED_QUESTION_TYPE"
  | "INVALID_OPTION_COUNT"
  | "DUPLICATE_OPTIONS"
  | "ANSWER_NOT_IN_OPTIONS"
  | "MISSING_SOURCE_SUPPORT"
  | "INVALID_DIFFICULTY"
  | "INVALID_TARGET_CONCEPT"
  | "OVERSIZED_FIELD"
  | "SUSPICIOUS_INSTRUCTION_FOLLOWING";

export interface QuizValidationResult {
  valid: boolean;
  reason: QuizValidationRejectionReason | null;
  citations: QuizCitation[]; // [] when invalid
  transferDimension: TransferLevel | null; // resolved (defaulted) dimension when valid, else null
  transferFallbackWarning: string | null; // §19's addition: TRANSFER_CHALLENGE -> APPLICATION fallback notice, logged not thrown
}

// Client-safe view -- never includes `correctAnswer` (Step 11/32: "client submission never
// authoritative for correctness," which starts with never even letting the client see the answer).
export interface QuizQuestionRecord {
  id: string;
  quizId: string;
  conceptId: string;
  questionType: QuestionType;
  questionText: string;
  options: string[] | null;
  irtDifficultyB: number;
  transferDimension: TransferLevel;
  citations: QuizCitation[];
  createdAt: string;
}

// Server-internal read only (scoring) -- adds the authoritative answer. Never returned from an API route.
export interface QuizQuestionInternal extends QuizQuestionRecord {
  correctAnswer: string;
}

export interface QuizRecord {
  id: string;
  studentId: string;
  sessionId: string | null;
  subject: string;
  action: QuizEligibleAction;
  targetConceptId: string;
  difficulty: DifficultyBand;
  status: QuizStatus;
  score: number | null;
  createdAt: string;
  submittedAt: string | null;
}

// The client may request a subject and the documents to ground generation in -- never a concept,
// difficulty, pedagogical action, mastery/ability/retention/readiness value, or scaffolding level
// (Step 4: "client input must NOT be authoritative for pedagogicalAction/difficulty/scaffolding/
// mastery/ability/retention/readiness"). Every one of those is resolved server-side via §17.
export interface QuizGenerationRequest {
  subject: string;
  documentIds: string[];
}

export type QuizGenerationResult =
  | { status: "generated"; quiz: QuizRecord; question: QuizQuestionRecord; rationale: PedagogicalReasonCode[] }
  | { status: "not_eligible"; action: PedagogicalAction; rationale: PedagogicalReasonCode[] }
  | { status: "insufficient_evidence" }
  | { status: "generation_failed"; reason: string };

export interface QuizAnswerRecord {
  id: string;
  quizId: string;
  questionId: string;
  studentId: string;
  submittedAnswer: string;
  correct: boolean;
  score: number; // 0..1 -- 1/0 for mcq, a graded fraction for short_answer
  evidenceTrust: "deterministic" | "llm_graded";
  feedback: string | null;
  responseTimeMs: number | null;
  sourceEventId: string; // the QUIZ_ANSWERED event this answer's evidence derives from
  createdAt: string;
}

export interface QuizSubmissionRequest {
  questionId: string;
  submittedAnswer: string;
  responseTimeMs?: number;
}

export interface QuizSubmissionResult {
  correct: boolean;
  score: number;
  feedback: string | null;
  quiz: QuizRecord;
  alreadyProcessed: boolean;
  nextActivity: NextActivityResult; // §20's "recompute pedagogical recommendation for the response payload" -- never persisted
}
