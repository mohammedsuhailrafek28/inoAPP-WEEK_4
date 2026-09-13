# FINAL ARCHITECTURE — Personalized AI Learning Engine

Status: **implemented architecture baseline** — originally designed for Week 3 and now serving as the learner-intelligence foundation of the final Week 4 system. Historical Week 2/Week 3 phase and migration labels below are preserved where they describe the system's evolution.

**Revision 2 changes everything from §7 onward** (mastery through the pedagogical decision engine, database, phases) following a locked decision: Week 3's learner-intelligence scope now covers the *complete* conceptual surface of [Tutor MCP](https://github.com/ArnaudGuiovanna/tutor-mcp) (BKT, PFA, IRT, FSRS-style retention, prerequisite graph, misconceptions, transfer, calibration, metacognition, autonomy, episodic/narrative memory, pedagogical next-activity selection) — **as a subsystem inside our Week 2-rooted architecture**, not as a parent architecture to imitate. Every design choice below was made by asking "what's the strongest version of *our* app," using Tutor MCP as a source of vetted algorithms and hard-won invariants, not as a template to copy. Where Tutor MCP's actual mechanism was weaker or less rigorous than what the task required (misconception lifecycle, transfer taxonomy), our design exceeds it and says so explicitly.

Tutor MCP was cloned and read at the source level (not just its README) for this revision — see §36 for the full source audit and license note.

**Revision 3 (lock)** resolves the three remaining open decisions from Revision 2's end-of-document list — algorithm-default governance (new §6A), the session-staleness threshold (§31, now locked at 90 minutes), and the visible learner-model/progress surface (§30, now fully specified) — and adds a full 22-point consistency check (§38) before declaring the architecture ready to build against. Nothing from Revision 2's substance was rewritten; this pass only integrates the three resolved decisions and fixes one small numeric drift caught during the consistency pass (§15's scaffolding tier bounds, corrected to match §36's audited source value exactly — see §6A's provenance table).

---

## 0. Workspace strategy (Step 1) — REVISED

**Supabase decision is now locked: Week 3 uses a fresh, independent Supabase project.** Week 2's database is frozen and must stay isolated from Week 3 migrations/experimentation. Week 3 conceptually reuses/adapts the Week 2 `documents`/`document_chunks`/`match_document_chunks` schema (§27 restates it verbatim as Week 3's own migration 001), but points at its own project — Week 3 runtime never has a network path to the Week 2 database. Documents will need to be re-uploaded into the new project; this is accepted as the cost of isolation.

Everything else from the original §0 stands: file-copy fork (not `git clone`), fresh `git init`, no Week 2 remote, `.env.local` recreated from scratch pointing at the new project.

---

## 1. Week 2 reusable baseline (Step 2 audit) — UNCHANGED

Retained verbatim from Revision 1 — nothing here changes. Summary: Next.js 16 App Router + React 19 + TypeScript, Tailwind v4, `@google/genai` (`gemini-3.6-flash` generation, `gemini-embedding-001`/768-dim embeddings), Supabase Postgres+pgvector+Storage, `pdfjs-dist`, `node:test`+tsx. Core RAG chain (`lib/documents/{retrieval,rag,rag-prompt,rag-generation,citations}.ts`) is dependency-injected, fully tested, and grounds every answer in server-owned citations with a deterministic insufficient-evidence refusal. Full file-level detail is unchanged from the original document version — see the file-list appendices in §37.

---

## 2. Core learner-intelligence requirements mapping — REVISED

| Requirement | Where it lands now |
|---|---|
| Student profile | `student_profiles` (§4) — unchanged from Revision 1 |
| AI learning memory | Six-layer memory model (§5): profile / algorithmic state / raw evidence / episodic / narrative / misconception |
| Personalized responses | `context-builder.ts` bounded LEARNER CONTEXT block (§22) feeding the *single* existing RAG prompt path (§21) |
| Adaptive-difficulty quizzes | Combined BKT+IRT+PFA+hysteresis policy (§16) |
| Performance analysis → revision | Deterministic ranking using retention urgency + misconception confidence + PFA plateau (§23) |
| Backend: profiling, academic data, learning context, quiz engine | `lib/learning/*`, `lib/quiz/*`, `lib/pedagogy/*` (§29) |
| **NEW** — full learner-intelligence scope (BKT/PFA/IRT/retention/prerequisites/misconceptions/transfer/calibration/metacognition/autonomy/pedagogical engine) | §7–§17, all deterministic, all typed, all independently testable per §34 |

---

## 3. Recommended architecture — REVISED (layered)

```
┌───────────────────────────────────────────────────────────────────────┐
│ PRODUCT LAYER              app/page.tsx shell — chat, quiz, progress   │
├───────────────────────────────────────────────────────────────────────┤
│ APPLICATION / ORCHESTRATION   app/api/* route handlers                 │
├───────────────────────────────────┬───────────────────────────────────┤
│ SOURCE INTELLIGENCE (Week 2,       │ LEARNER INTELLIGENCE               │
│ UNCHANGED)                         │ (Tutor-MCP-informed, §7–§15)       │
│  lib/documents/{retrieval,rag,     │  lib/learning/{bkt,pfa,irt,        │
│  rag-prompt,rag-generation,        │  retention,concepts,               │
│  citations}.ts                     │  misconceptions,transfer,          │
│  → grounded facts + citations      │  calibration,metacognition,        │
│                                     │  autonomy}.ts                      │
│                                     │  → deterministic learner state     │
├───────────────────────────────────┴───────────────────────────────────┤
│ PEDAGOGICAL DECISION ENGINE   lib/pedagogy/{phase,select,difficulty}.ts │
│  Inputs: Source Intelligence availability + Learner Intelligence state │
│  Output: ONE action from a controlled enum (§17) + target difficulty   │
├───────────────────────────────────────────────────────────────────────┤
│ GENERATIVE INTELLIGENCE (Gemini)   explains, hints, phrases, generates  │
│  quiz text — NEVER decides state, NEVER decides the next action        │
├───────────────────────────────────────────────────────────────────────┤
│ TRUST / VALIDATION LAYER   lib/quiz/validation.ts, evaluation.ts,       │
│  authoritative-vs-candidate gates (§32) — every LLM output is evidence,│
│  never a command                                                       │
├───────────────────────────────────────────────────────────────────────┤
│ DATA + EVIDENCE LAYER   Postgres/Supabase — immutable learning_events   │
│  + derived learner_concept_state/learner_ability/calibration_records    │
└───────────────────────────────────────────────────────────────────────┘
   Cross-cutting: Observability & Testing (§34) — every layer above is
   independently unit-testable with no network calls, mirroring Week 2.
```

This is the layering the task requested, with one addition: **Trust/Validation is pulled out as its own layer** rather than folded into Learner Intelligence, because its job is categorically different — it's the boundary that decides what generative output is even allowed to become evidence, and it needs to be auditable on its own (this directly answers §32's authority questions).

---

## 4. Data model — student profile (Step 3) — UNCHANGED

Retained verbatim from Revision 1: `StudentProfile{id, displayName, academicLevel, subjects[], learningGoals, preferredExplanationStyle, preferredDifficulty, preferredPace, examplePreference, createdAt, updatedAt}`, reusing Week 2's `ExplanationMode` enum. No psychometric traits, no learning-style labels. Validation rules unchanged (§ from Revision 1).

---

## 5. Memory architecture — REVISED (six layers, explicit provenance)

Tutor MCP's own vocabulary ("hippocampal episodes" vs. "neocortex/stable state") maps cleanly onto a relational schema; we adopt the *layering idea* and the *bounded-context-loading pattern* (§22), but implement it as ordinary Postgres rows with a status column, not markdown files with CAS versioning and encryption key rotation — that machinery exists in Tutor MCP to serve many tenants writing concurrently, which does not describe this app (see §36 for why that's classified NOT SUITABLE).

| Layer | Contents | Provenance | Table | Mutable? |
|---|---|---|---|---|
| A. Profile memory | Explicit declared preferences | `user_declared` | `student_profiles` | Yes, student-initiated only |
| B. Algorithmic state | BKT/IRT/FSRS/prerequisite/PFA-derived-on-read state | `calculated` | `learner_concept_state`, `learner_ability` | Only by `lib/learning/*` deterministic updaters |
| C. Raw evidence | Immutable interaction log | `calculated` (fact: "this happened") | `learning_events` | Never — append-only |
| D. Episodic memory | Per-session record: concepts touched, quiz results, one LLM-authored recap | `calculated` (metadata) + `llm_observed` (recap text) | `learning_sessions` | Recap set once at session close |
| E. Narrative memory | Stable, cross-session observations about the learner ("consistently strong at recursion, weak at pointer arithmetic") | `llm_suggested` → `corroborated` only after repeated evidence | `narrative_memories` | Promoted pending→confirmed by deterministic corroboration rule (§5.1), never by the LLM's say-so alone |
| F. Misconception memory | Recurring, tagged error patterns with a real lifecycle | Mixed: tag/status `calculated`, description `llm_observed` | `misconceptions` | Status transitions are deterministic (§11) |

### 5.1 Narrative memory corroboration rule

The LLM may write a **candidate** narrative observation any time (bounded: max 300 chars, one sentence). It starts `status='pending'`. A pending observation is promoted to `status='confirmed'` only when a *second*, independently-generated observation with a similar theme (cheap string-similarity check — normalized token overlap ≥ 0.6, no embedding call) is proposed in a *later* session. This directly closes the exact gap the Tutor MCP audit found in its own misconception subsystem (an LLM label becoming authoritative on a single say-so) — we apply the same "no single LLM utterance is authoritative" rule to narrative memory too, which Tutor MCP does not do (its own consolidation is fully LLM-trusted). Confirmed observations are capped at 20 per student (oldest evicted first); pending at 10. This is deliberately much smaller than Tutor MCP's 16 MB/learner narrative quota, because our narrative layer is a *supplement* to a much smaller, tightly-bounded prompt context (§22), not the primary memory substrate their MCP protocol relies on.

---

## 6. Concept model & prerequisite graph (Step 5) — REVISED

Normalized concept IDs are retained from Revision 1 (`normalizeTopicKey` → `learning_concepts.concept_key`, unique, alias-tracking) — that part was already correct and stays. What's added is a **lightweight directed prerequisite graph**, per the locked revision (Critical Revision 5), which supersedes Revision 1's "no graph" call.

```sql
learning_concepts (
  id uuid PK, subject text, concept_key text UNIQUE, display_name text, aliases text[] default '{}',
  default_p_l0 float null,        -- BKT prior override, falls back to a global constant if null
  default_p_t float null,         -- BKT learning-rate override
  created_at timestamptz
)

concept_prerequisites (
  concept_id uuid FK -> learning_concepts(id) ON DELETE CASCADE,
  prerequisite_concept_id uuid FK -> learning_concepts(id) ON DELETE CASCADE,
  created_at timestamptz,
  PRIMARY KEY (concept_id, prerequisite_concept_id),
  CHECK (concept_id <> prerequisite_concept_id)      -- blocks the trivial self-loop at the DB level
)
```

**Cycle prevention:** enforced in application code at edge-insert time only (not on every read) — before inserting `(A prerequisite-of B)`, run a DFS from `B` over existing edges looking for a path back to `A`; reject with a full cycle path in the error message (`"a → b → c → a"`), mirroring Tutor MCP's `findPrereqCycle` exactly (classified ADAPT DIRECTLY in §36 — it's a ~20-line DFS, no reason to simplify further). Cycle detection never runs on a read path; the graph is small (internship-scope, one subject at a time) and mutated rarely (only when a new quiz introduces a concept), so authoring-time validation is sufficient.

**Readiness / gating** — direct port of Tutor MCP's KST binary AND-gate, using a threshold *distinct from* the BKT "mastered" verdict (see §16 for why two thresholds are correct here, not redundant):

```
isReadyFor(concept) = every direct prerequisite p of concept has
                       learner_concept_state[p].p_mastery >= MASTERY_READY_THRESHOLD (0.70)
```

Only *direct* prerequisites are checked per call; transitive gating falls out naturally because an ancestor concept can't itself be "ready" until its own prerequisites clear (same emergent-cascade property Tutor MCP relies on). Example from the task: `hashing → rolling-hash → rabin-karp` — a student can't be selected into `rabin-karp` INSTRUCTION-phase practice until `rolling-hash`'s mastery clears 0.70, and can't reach `rolling-hash` until `hashing` does.

**Blocked-advanced-topic UX:** when a student's quiz selection would otherwise pick a concept that's not ready, the pedagogical engine (§17) emits `PREREQUISITE_REMEDIATION` targeting the *unready prerequisite*, not the originally-requested concept — this is the "prerequisite remediation" pathway from the task's action enum.

---

## 6A. Configuration governance & constants registry — Decision 1 (LOCKED)

Every tunable value referenced anywhere in §7–§23 lives in exactly one typed, frozen module, `lib/learning/constants.ts`, exporting a single object `LEARNING_CONFIG` carrying a `version: 1` field. **No constant is ever scattered inline into a service file**, and no tuning value is ever exposed through an API parameter, a client-writable field, or an admin UI — every value below is a compile-time constant, full stop. This module and this rule are the direct, standalone answer to consistency-check item 21 (§38).

**Versioned, not hardcoded-forever:** if real usage data (post-Phase 13) ever justifies changing a value, the change is a version bump (`version: 2`) with the old value's row kept in this table for history, never a silent in-place edit. Per §20, `learning_events.metadata` should record which `configVersion` was active at compute time, so historical BKT/IRT/FSRS updates remain exactly replayable even after the config changes — this requires no schema change (the column is already `jsonb`).

**No empirical tuning yet** — every value below is a literature-consistent or source-adopted *starting point*, explicitly not fitted to real learner data, because none exists yet. This is deliberate, per Decision 1, not an oversight.

Three categories, kept as three separate exported objects (not one flat list), because they answer three different questions:

### MODEL_PARAMETERS — govern the mathematical model itself

| Constant | Value | Provenance |
|---|---|---|
| `BKT_DEFAULT_P_L0` | 0.20 | OUR_CHOICE — conservative "assume not yet known" prior, within the commonly-cited 0.1–0.3 range for Corbett & Anderson-style BKT deployments; no fitted value exists |
| `BKT_DEFAULT_P_T` | 0.30 | OUR_CHOICE — within the commonly-cited BKT learning-rate range |
| `BKT_DEFAULT_P_S_MCQ` / `BKT_DEFAULT_P_S_SHORT_ANSWER` | 0.10 / 0.15 | OUR_CHOICE — Tutor MCP has a single global `P(S)`; we introduce a per-question-type split (short-answer higher, for LLM-grading noise) that has no source-project equivalent |
| `BKT_DEFAULT_P_G_MCQ` / `BKT_DEFAULT_P_G_SHORT_ANSWER` | 0.22 / 0.05 | OUR_CHOICE — approximates 1-in-~4.5 for a typical MCQ, near-zero blind-guess chance for free text |
| `BKT_FORGET_WITHIN_SESSION` | 0.02 | OUR_CHOICE — Tutor MCP exposes a live `P(Forget)` field but never mutates it at any call site the audit found; we fix it as a small constant rather than carry unused flexibility |
| `PFA_BETA_SUCCESS` / `PFA_BETA_FAILURE` | +0.11 / −0.11 | TUTOR_MCP_CHOICE — adopted verbatim (§8) |
| `IRT_THETA_BOUNDS` | [−4, 4] | TUTOR_MCP_CHOICE (§9.3) |
| `IRT_BASE_PRIOR_PRECISION` | 1.0 | TUTOR_MCP_CHOICE (§9.3) |
| `IRT_INFO_PER_OBSERVATION` | 0.25 | PUBLISHED_ALGORITHM — the maximum Fisher information of a discrimination-1 2PL item is a mathematical property of the model, not a tuned choice |
| `IRT_MAX_NEWTON_STEP` | 1.0 | TUTOR_MCP_CHOICE |
| `IRT_ITEM_DIFFICULTY_B` | easy −1.0 / medium 0.0 / hard +1.0 | OUR_CHOICE — no FSRS-borrowed mapping exists in our design (§9.2); Tutor MCP's own mapping doesn't apply since our item difficulty isn't FSRS-derived |
| `FSRS_WEIGHTS` (19 values) | listed in §10.2 | PUBLISHED_ALGORITHM — the Open-Spaced-Repetition project's own published default parameterization, not Tutor MCP's invention (Tutor MCP itself credits this project in its own README) |
| `FSRS_FACTOR` / `FSRS_DECAY` | 19/81, −0.5 | PUBLISHED_ALGORITHM |
| `FSRS_DESIRED_RETENTION` | 0.9 | PUBLISHED_ALGORITHM / common FSRS operational convention, adopted by both Tutor MCP and us |

### PRODUCT_POLICY_THRESHOLDS — govern when the pedagogical engine acts on the model's output

| Constant | Value | Provenance |
|---|---|---|
| `MASTERY_READY_THRESHOLD` | 0.70 | TUTOR_MCP_CHOICE — their legacy KST-profile value, adopted (§6, §7.3) |
| `MASTERY_ACHIEVED_THRESHOLD` | 0.85 | TUTOR_MCP_CHOICE — their unified-profile value, adopted (§7.3) |
| `DIFFICULTY_HYSTERESIS_BANDS` | rise 0.45 / 0.75, fall 0.35 / 0.65 | OUR_CHOICE — introduced in Revision 1; no Tutor MCP equivalent (§16) |
| `MIN_EVIDENCE_FOR_ADAPTIVE` | 3 | OUR_CHOICE (§7.5, §9.4) |
| `RETENTION_WARNING` / `RETENTION_CRITICAL` / `RETENTION_ROUTING` | 0.40 / 0.30 / 0.50 | TUTOR_MCP_CHOICE (§10.3) |
| `PFA_PLATEAU_DELTA` / `PFA_PLATEAU_WINDOW` | 0.025 / 4 | TUTOR_MCP_CHOICE (§8) |
| `MISCONCEPTION_RESOLUTION_WINDOW` | 3 | TUTOR_MCP_CHOICE — adopted directly (§11) |
| `TRANSFER_FAILURE_THRESHOLD` | 0.50 | TUTOR_MCP_CHOICE (§12) |
| `CALIBRATION_ACTIONABLE_BIAS` / `CALIBRATION_MIN_SAMPLES` | 0.25 / 5 | TUTOR_MCP_CHOICE (§13) |
| `AUTONOMY_COMPONENT_WEIGHTS` | 0.25 each, 4 components | TUTOR_MCP_CHOICE (§15) |
| `SCAFFOLDING_TIER_BOUNDS` | 0.3 / 0.7 | TUTOR_MCP_CHOICE — **corrected in this lock** to match their fade-tier values exactly; Revision 2's §15 text had drifted to 0.35 with no stated rationale, fixed here to remove an unexplained deviation |
| `STALE_SESSION_MINUTES` | **90** | OUR_CHOICE — **locked by explicit product decision, Decision 2 (§31)**; not derived from Tutor MCP, whose OVERLOAD alert at 45 minutes answers a different question (single-sitting fatigue, not cross-visit staleness) |
| `LEARNER_CONTEXT_BUDGET_CHARS` | 1,500 | OUR_CHOICE (§22) |

### SAFETY_CLAMPS — prevent numerical or pedagogical blowup regardless of the above

| Constant | Value | Provenance |
|---|---|---|
| `BKT_MASTERY_CLAMP` | **[0.02, 0.98]** | OUR_CHOICE — **stronger than Tutor MCP's plain [0, 1]**, kept per Decision 1's explicit instruction. Mathematical review: a `[0.02, 0.98]` clamp introduces no directional bias — it only prevents the posterior from reaching an exact 0 or 1, which would otherwise make the Bayesian update's denominators degenerate into an absorbing state immune to further evidence. No legitimate issue was found in review; **the stronger clamp stands as designed** |
| `IRT_NEWTON_STEP_CLAMP` | [−1, 1] | TUTOR_MCP_CHOICE |
| `FSRS_STABILITY_DIFFICULTY_FLOOR` | 1e-9 | PUBLISHED_ALGORITHM — an anti-`Pow(0,-k)`-Infinity guard inherent to the formula, not a tuned choice |
| `BKT_BAYES_DENOMINATOR_FLOOR` | 1e-9 | TUTOR_MCP_CHOICE |
| `DIFFICULTY_MAX_STEP_PER_QUIZ` | 1 band | OUR_CHOICE — anti-oscillation ceiling (§16) |
| `CALIBRATION_RANGE` | predicted/actual ∈ [0, 1] | Mathematical necessity, enforced via a DB `CHECK` constraint, not a policy choice |

**IRT model re-review** (per Decision 1's instruction to retain 1PL unless the architecture demonstrates 2PL is materially necessary): nothing in §9, §16, or §17 ever reads a per-item discrimination parameter — item difficulty (`b`) alone drives every consumer (the ZPD-band check, the quiz-difficulty sanity nudge). **1PL/Rasch is retained**; introducing a discrimination parameter `a` would add a dimension with no consumer and no data to fit it against.

---

## 7. Mastery — BKT (Bayesian Knowledge Tracing) — Step 6, Critical Revision 1

The Revision-1 weighted-EMA design is **fully replaced**. BKT is now the authoritative mastery model, ported from the source-verified Tutor MCP formulas (`algorithms/bkt.go`, confirmed by its test suite — hand-checked in the audit: `{P_L:0.5, P_T:0.3, P_Forget:0.05, P_S:0.1, P_G:0.2}` → correct gives exactly 0.8318, incorrect gives exactly 0.3722).

### 7.1 State

Per `(student_id, concept_id)`, stored in `learner_concept_state`:
- `p_mastery` (= P(L), the live estimate — the only BKT field that mutates per attempt)
- `evidence_count`, `correct_count`, `incorrect_count`

Per-item parameters (`P(T)`, `P(S)`, `P(G)`) are **not** per-student — see §7.4.

### 7.2 Update formulas (deterministic, pure function — `lib/learning/bkt.ts::applyBktUpdate`)

Given prior `pMastery`, item parameters `{pLearn, pSlip, pGuess}`, and an observed outcome:

**Correct:**
```
pCorrectGivenMastery    = 1 - pSlip
pCorrectGivenNotMastery = pGuess
pCorrect = max(pCorrectGivenMastery*pMastery + pCorrectGivenNotMastery*(1-pMastery), 1e-9)
posterior = pCorrectGivenMastery * pMastery / pCorrect
```
**Incorrect:**
```
pIncorrectGivenMastery    = pSlip
pIncorrectGivenNotMastery = 1 - pGuess
pIncorrect = max(pIncorrectGivenMastery*pMastery + pIncorrectGivenNotMastery*(1-pMastery), 1e-9)
posterior = pIncorrectGivenMastery * pMastery / pIncorrect
```
**Learning transition (both branches):**
```
newPMastery = posterior*(1 - pForget) + (1-posterior)*pLearn
```
**Clamping — stronger than the source:** the audit found Tutor MCP clamps only to `[0, 1]`, which allows mastery to reach an *absorbing state* (exactly 0 or 1) that no further evidence can move. We clamp to **`[0.02, 0.98]`** instead — a standard BKT refinement that keeps the model perpetually responsive to new evidence. This is a case of preserving something stronger than the source, per the task's instruction.

`p_forget` is treated as a small fixed constant (`P_FORGET_WITHIN_SESSION = 0.02`, distinct from FSRS's cross-session forgetting model in §10) rather than a live per-concept field — Tutor MCP models it as mutable state without ever actually mutating it at any call site the audit found; we simplify honestly rather than carrying dead flexibility.

### 7.3 Mastery threshold

`MASTERY_ACHIEVED_THRESHOLD = 0.85` — `isMastered(state) = state.p_mastery >= 0.85`. This is the "hard" BKT verdict (mastery-challenge/transfer eligibility gate). It is intentionally **higher** than `MASTERY_READY_THRESHOLD = 0.70` (§6's prerequisite-unlock gate) — being "good enough to move on to dependent material" and "fully mastered" are different pedagogical questions, and Tutor MCP's own codebase (in its non-legacy default profile) actually *unifies* these to the same 0.85, which the audit flagged as a real drift between its documented design and shipped defaults. We deliberately keep them **separate**, because the distinction is pedagogically real and cheap to keep: it costs one more named constant, not a second data model.

### 7.4 Global vs. per-concept parameters

| Parameter | Scope | Default | Override |
|---|---|---|---|
| `P(L0)` — initial mastery prior | Per concept | `0.20` (assume not known) | `learning_concepts.default_p_l0` |
| `P(T)` — learning-rate/transition | Per concept | `0.30` | `learning_concepts.default_p_t` |
| `P(S)` — slip | Per **(concept, question_type)** | MCQ: `0.10`, short-answer: `0.15` (LLM-graded rubric noise) | none in v1 |
| `P(G)` — guess | Per **(concept, question_type)** | MCQ: `0.22` (≈1-in-4.5), short-answer: `0.05` | none in v1 |

**No per-student individualization in v1.** Tutor MCP's `individual_bkt.go` adjusts `P(T)/P(S)/P(G)` from a rolling 20-interaction per-student window, with an evidence-ramp weight `w = min(observations/20, 1)` specifically to avoid overfitting to sparse data. The audit confirms this needs real volume to be safe (a single-semester internship demo will rarely accumulate 20 interactions on one concept for one student). We record the exact ramp-weight formula here as a **documented, deferred enhancement** (§36 classifies it REIMPLEMENT CONCEPTUALLY, not now) rather than building it now on data that can't support it safely.

### 7.5 Sparse-evidence safeguard

`evidence_count < MIN_EVIDENCE_FOR_ADAPTIVE (3)` → every downstream consumer (difficulty selection, revision ranking, "mastered" badge) treats `p_mastery` as provisional, exactly as in Revision 1 — this rule survives unchanged, just now guarding a BKT posterior instead of an EMA.

### 7.6 Update-rule reference table (per the original task's explicit request)

| Event | Effect on `p_mastery` |
|---|---|
| Correct, easy/MCQ (low `P(S)`, higher `P(G)`) | Moderate rise — a correct MCQ answer is *weaker* evidence than a correct short answer, because `P(G)=0.22` means "correct by chance" is non-trivially likely |
| Correct, hard/short-answer (higher `P(S)`, low `P(G)`) | Larger rise — low guess probability makes a correct answer strong evidence |
| Incorrect | Fall, magnitude set by `P(S)` vs `P(G)` — a wrong MCQ answer is *weak* evidence of not-knowing (could've been a slip on an easy guess-prone item); a wrong short answer is *strong* evidence |
| Partial (short-answer rubric score `r∈[0,1]`) | Treated as a **weighted blend of the correct/incorrect BKT branches**: `posterior = r*posteriorIfCorrect + (1-r)*posteriorIfIncorrect`, then the same learning-transition step applies — not a separate formula |
| Repeated mistakes | No special-cased formula — BKT's own repeated-incorrect Bayesian updates naturally compound; the *separate* misconception subsystem (§11) is what tracks "repeated" as a first-class signal |
| Insufficient evidence | `evidence_count < 3` → provisional flag, §7.5 |

---

## 8. PFA (Performance Factors Analysis) — Critical Revision 2

**PFA is explicitly not a second mastery score.** Its defined purpose, matching what the Tutor MCP audit found at PFA's actual call sites (it never touches BKT's `p_mastery`, and vice versa): **a stagnation/plateau detector that feeds the pedagogical engine's difficulty-selection modifier (§16) and the PLATEAU alert (§23)** — nothing else.

**No new storage.** PFA opportunities/successes/failures are the *same* `correct_count`/`incorrect_count` already tracked for BKT bookkeeping in `learner_concept_state` — this is the concrete resolution the task asked for ("do not create a second redundant mastery score without defining the relationship"). Plateau detection additionally needs the *sequence* of recent outcomes, which is reconstructed on demand from the last 4 relevant `learning_events` rows for that concept (no separate PFA table).

```
pfaScore(successes, failures) = 0.11*successes - 0.11*failures     // symmetric, no intercept — direct port
pfaProbability = sigmoid(pfaScore)
```
```
isPlateaued(recentEvents, window=4):
  if fewer than 4 relevant events exist: false
  replay pfaProbability cumulatively across the last 4 outcomes
  return max(|adjacent deltas|) < 0.025
```
The sigmoid is required (not the raw linear score) because raw PFA score changes by a constant ±0.11 per event and would never register as "flat" — only the *saturating* probability can plateau. This is a direct, verified port (§36: ADAPT DIRECTLY).

---

## 9. IRT (Item Response Theory) — Critical Revision 3

**Model choice: 1PL Rasch, computed via a fixed-discrimination 2PL formula (`a = 1` always).** The audit found Tutor MCP's code is *technically* 2PL-capable but hardcodes `a=1` at its only call site — i.e., it runs as 1PL in practice despite the extra parameter. We adopt the same effective model but state it honestly as 1PL and don't even expose a discrimination column, per "prefer the minimum justified model": fitting a real discrimination parameter needs response data we won't have at this scale.

### 9.1 Scope: ability is per (student, subject), not per concept

```sql
learner_ability (
  student_id uuid FK cascade, subject text,
  theta float default 0, observation_count int default 0, updated_at timestamptz,
  PRIMARY KEY (student_id, subject)
)
```
This is a deliberate schema decision distinct from `learner_concept_state`: ability is a property of the learner *in a domain*, not of one concept, exactly matching the classical IRT model — an insight surfaced directly by the audit reading the actual call sites (Tutor MCP itself doesn't need this split because its `theta` field lives inconsistently; we make the scoping explicit).

### 9.2 Item difficulty (b)

Assigned at quiz-generation/validation time via a fixed, auditable mapping from the existing difficulty enum — no FSRS-borrowed mapping (that trick exists in Tutor MCP only because their item difficulty *is* FSRS review difficulty; ours is an independent per-question label):
```
b(easy) = -1.0,  b(medium) = 0.0,  b(hard) = +1.0
```

### 9.3 Ability update — regularized, single Newton step per response

Direct, verified port of the "regularized cumulative online update" the task asked for, simplified from Tutor MCP's up-to-8-iteration batch fit to **one Newton step per incoming response** (since we update incrementally, one response at a time, not refitting a whole history each call):
```
priorPrecision = 1.0 + 0.25 * observationCount     // 0.25 = max Fisher info of an a=1 2PL item
predicted = sigmoid(theta - b)
dL  = -priorPrecision*(theta - priorTheta) + (outcome - predicted)     // outcome ∈ {0,1}
d2L = -priorPrecision - predicted*(1-predicted)
step = clamp(dL/d2L, -1, 1)
theta' = clamp(theta - step, -4, 4)
observationCount' = observationCount + 1
```
The `priorPrecision` term grows with `observationCount`, which is exactly what prevents one binary response from saturating θ (verified in the source tests: a single correct response from θ=0 against a difficulty-2 item moves θ partway into `(0,2)`, never to a boundary).

### 9.4 Question selection near ability + sparse-estimate prevention

The ZPD band is reused directly: **`0.55 ≤ sigmoid(theta - b) ≤ 0.80`**. Rather than solving for a continuous `b`, theta is used as a **sanity check on the discrete difficulty band** chosen by §16's combined policy: if `observationCount ≥ 3` (same `MIN_EVIDENCE_FOR_ADAPTIVE` floor used everywhere else) and the selected band's typical `b` predicts `P(correct)` outside `[0.40, 0.90]` given current θ, nudge the band one step toward center. Below 3 observations, θ is ignored entirely and difficulty selection falls back purely to BKT + the evidence floor — this is the "prevent extreme/sparse estimates" rule the task asked for, expressed as a floor rather than a special-cased formula.

---

## 10. Retention — FSRS-style review scheduling — Critical Revision 4

**Mastery and retention are fully separate signals**, stored as separate columns in the *same* `learner_concept_state` row (they don't need separate tables — see §27) but never conflated: a concept can have `p_mastery = 0.9` and simultaneously be "due for review" because retrievability has decayed since last practiced.

**Adaptation to concepts, not flashcards:** the audit confirmed Tutor MCP itself treats one concept as exactly one FSRS "card" — there is no special flashcard-vs-concept adaptation to invent; we adopt the same 1:1 mapping. Every quiz-question attempt or explanation-then-check interaction on a concept is one FSRS review event for that concept's card.

### 10.1 State (in `learner_concept_state`)

`stability`, `retention_difficulty` (named distinctly from IRT's item difficulty and the quiz's difficulty enum — three different "difficulty" concepts, kept in three different columns on purpose), `last_reviewed_at`, `next_review_at`, `reps`, `lapses`, `card_state ∈ {new, learning, review, relearning}`.

### 10.2 Formulas — ported verbatim (these are FSRS's own published defaults, not Tutor MCP's invention, so verbatim porting is the correct call, not a shortcut)

```
retrievability(elapsedDays, stability) = (1 + (19/81)*elapsedDays/stability) ^ (-0.5),  stability floored at 1e-9
```
Initial stability/difficulty on first review (`rating ∈ {Again, Good}` only — we drop Hard/Easy, see below):
```
initialStability(Good) = w2 (=3.1262),  initialStability(Again) = w0 (=0.4072)
initialDifficulty(r) = clamp(w4 - exp(w5*(r-1)) + 1, 1, 10)     // w4=7.2102, w5=0.5316
```
Next stability on a successful (Good) review:
```
S' = S * (exp(w8) * (11-D) * S^(-w9) * (exp(w10*(1-R)) - 1) + 1)     // w8=1.5330, w9=0.1544, w10=1.0166
```
Next stability on a lapse (Again, from `review` state):
```
S_forget = w11 * D^(-w12) * ((S+1)^w13 - 1) * exp(w14*(1-R))         // w11=1.9210, w12=0.0854, w13=0.2698, w14=2.2694
```
Next review interval, `desiredRetention = 0.9` (a named, documented constant, not a magic literal):
```
nextIntervalDays = max(1, round( S/(19/81) * (0.9^(-2) - 1) ))
```

**Simplification kept from the audit's advice:** only `Good`/`Again` ratings are used (mapped 1:1 from `success: true/false` on any interaction), dropping FSRS's `Hard`/`Easy` self-graded ratings — the audit confirmed Tutor MCP's own live traffic never actually drives those two paths either, so this isn't a loss of fidelity, just dead-path removal.

### 10.3 Retention urgency (three tiers, reusing the same numbers as the FORGETTING alert)

```
retrievability >= 0.50  → not urgent
0.30 <= retrievability < 0.50 → WARNING (surfaced in revision recommendations)
retrievability < 0.30 → CRITICAL (forces SPACED_REVIEW in the pedagogical engine, §17, and bypasses anti-repeat)
```

---

## 11. Misconceptions — Critical Revision 6 (stronger than the source)

The audit found Tutor MCP has **no real misconception lifecycle at all** — it's a free-text label on an interaction row with no candidate/confidence/resolution state machine, and critically, **the LLM's proposed label becomes authoritative the instant it's written**, with no confirmation gate. The task explicitly asks for more rigor than that, and our existing Week 2 trust model (LLM output is evidence, never a command) already requires more. So this subsystem is **our own design**, informed by one cheap, well-tested idea from the source (the resolution-window heuristic) but not copied wholesale.

```sql
misconceptions (
  id uuid PK, student_id uuid FK cascade, concept_id uuid FK restrict,
  tag text,                      -- short machine-stable key, e.g. "off_by_one_boundary"
  description text,              -- one sentence, llm_observed
  status text CHECK IN ('candidate','active','resolved'),
  evidence_count int default 1,
  first_seen_at, last_seen_at timestamptz,
  UNIQUE (student_id, concept_id, tag)
)
```

**Lifecycle** (exactly the chain the task specified):

1. **Candidate** — Gemini, evaluating an incorrect answer, MAY propose `{tag, description}`. This is written with `status='candidate', evidence_count=1`. The LLM's authority ends here.
2. **Evidence accumulates, deterministically** — a *second* incorrect answer on the same `(concept, tag)` (same tag string, from a curated-enough vocabulary that near-duplicate tags collapse — normalized the same way concept keys are, §6) increments `evidence_count` and, at `evidence_count >= 2`, deterministically flips `status → 'active'`. The LLM never sets `status` directly.
3. **Targeted remediation** — an `active` misconception forces the pedagogical engine's `EXPLAIN` action with a `focus: 'misconception'` directive naming the tag (§17), and locks quiz generation to include at least one question addressing it.
4. **Successful counter-evidence → resolved** — mirroring Tutor MCP's `MisconceptionResolutionWindow = 3` (a genuinely good, cheap idea, ported directly): status recomputation checks the student's last 3 interactions on that concept; if none of them re-trigger the same tag, `status → 'resolved'`. Unlike Tutor MCP, this recomputation is a scheduled/on-read deterministic pass, not a live derived value with no persisted status — we persist status explicitly so `active` misconceptions can drive gating (§6, §17) without recomputing a window on every read.

**Authorization boundary (the fix over the source):** `status` is *never* writable by the LLM's tool-call/response payload — the API layer for "record short-answer evaluation" accepts only `{proposedTag?, proposedDescription?}` from Gemini's structured output, and a separate, deterministic function (`lib/learning/misconceptions.ts::recordEvidence`) is the only code path allowed to write `status`/`evidence_count`.

---

## 12. Transfer tracking — Critical Revision 7

Simplified from Tutor MCP's five dimensions (`near/far/debugging/teaching/creative`) to the three the task actually asked for — **RECALL, APPLICATION, TRANSFER** — because five dimensions need volume this app won't have, but the *trust-tiering* idea underneath is kept and is the valuable part.

**Storage: no new table.** Six small integer columns on `learner_concept_state`: `recall_attempts/successes`, `application_attempts/successes`, `transfer_attempts/successes` — this is the DB re-review answering "can transfer live coherently inside `learner_concept_state`": yes, as counters, exactly like the BKT/PFA counters already there.

**Category assignment:** set at quiz-question-generation time, not inferred after the fact — `question_type=mcq → recall` by default; `question_type=short_answer → application` by default; `transfer` is only assigned when the pedagogical engine explicitly requests a `TRANSFER_CHALLENGE` activity, in which case the generation prompt is instructed to draw the scenario from a **different** selected-document context than where the concept was first introduced (checked with a cheap deterministic signal: the cited source chunk(s) differ from the chunk(s) originally retrieved when the concept was first explained — a weak but honest and free check, not a claim of certainty).

**Readiness ladder (simplified to 3 states, from Tutor MCP's 6):**
```
not_attempted  → no transfer-category attempts yet
attempted      → at least 1 transfer attempt, but the most recent one scored < 0.60
ready          → at least 1 application success recorded AND the most recent transfer attempt scored >= 0.60
```
Like the source, this is **recomputed fresh from the counters each time**, not a ratcheted state — a fresh transfer failure can move a concept back from `ready` to `attempted` immediately, which is the honest behavior (transfer competence isn't permanently "banked").

**Trust tier — adopted directly from the audit's sharpest finding:** a transfer score written by Gemini's own grading (`evaluation_method = 'host_llm'`, our only evaluation method — see §32, we have no external/human-review evaluator) counts toward the raw counters immediately, but is **explicitly labeled `evidence_trust: 'llm_graded'`** in the stored event metadata, and the pedagogical engine's `TRANSFER_CHALLENGE`-eligibility check (§17) requires **application-success evidence** (recall/application questions are graded far more cheaply — MCQ is deterministic, short-answer rubric grading is lower-stakes) before ever routing to a transfer probe at all, rather than pretending host-LLM-graded transfer scores are as trustworthy as a deterministic check. This is the practical version of Tutor MCP's "host-LLM grading can never produce `trusted` evidence" rule, adapted to a system that (unlike Tutor MCP) has no external/human evaluator tier to fall back on.

Integration into quiz selection: §17's action selector routes to `TRANSFER_CHALLENGE` only when `p_mastery >= MASTERY_ACHIEVED_THRESHOLD` AND evidence is "diverse" (≥2 distinct `question_type`s answered correctly on the concept — a simplified stand-in for Tutor MCP's fuller evidence-quality apparatus, per §36's SIMPLIFY classification) AND transfer readiness `!= ready`.

---

## 13. Calibration — Critical Revision 8

Adopted **directly** — this is the cleanest, most directly portable subsystem in the whole audit.

```sql
calibration_records (
  id uuid PK, student_id uuid FK cascade, concept_id uuid FK restrict null,
  predicted float CHECK (predicted between 0 and 1),   -- from a 1-5 Likert self-rating: (rating-1)/4
  actual float CHECK (actual between 0 and 1) null,
  delta float null,                                     -- predicted - actual, signed
  created_at timestamptz, resolved_at timestamptz null
)
```
This is the one piece of student-authoritative-but-mutable state outside profile/mastery — a prediction is opened (student self-rates confidence before answering) and *resolved* later (once the actual outcome is known), so it can't be an immutable event row; it's explicitly flagged here as the one deliberate exception to "evidence is append-only."

```
bias = AVG(delta) over the student's most recent 20 resolved records   -- simple rolling mean, not EWMA
isActionable(bias, sampleCount) = sampleCount >= 5 AND |bias| >= 0.25   -- ONE reusable predicate, used everywhere below
```

**Detection, not a vague score:** `bias > 0` and actionable → overconfidence pattern (surfaced as "you've been more confident than your results support" — a factual mirror statement, not a psychological diagnosis, per §14); `bias < 0` and actionable → underconfidence. High-confidence-wrong / low-confidence-correct are just the individual `delta` values with large magnitude — no separate metric invented for them.

This feeds **only** the autonomy score (§15) and the metacognitive mirror (§14) — it does not gate quiz difficulty directly (kept as its own signal, not folded into §16's difficulty policy, matching the source exactly).

---

## 14. Metacognition — Critical Revision 9

Evidence-based only, no invented AI score. Four deterministic pattern checks, priority-ordered, first match wins (direct, small port of Tutor MCP's `DetectMirrorPattern`, stripped of its Discord-webhook delivery mechanics which are irrelevant here):

1. **Dependency-increasing** — the student's autonomy score (§15) has declined across the 3 most recent sessions, monotonically.
2. **Hint overuse** — on concepts already at `p_mastery >= MASTERY_ACHIEVED_THRESHOLD`, hint-requested rate over the last ≥5 interactions on those concepts exceeds 50%.
3. **No initiative** — across the last 3+ sessions, zero self-initiated interactions (a "self-initiated" interaction is one the student started without being prompted by a revision recommendation or scheduled review nudge — a boolean set at event-write time).
4. **Calibration drift** — reuses `isActionable(bias, sampleCount)` from §13 verbatim.

Output is always a **factual mirror message phrased as a question**, never a diagnosis ("Your last three sessions show declining initiative on new topics — is something making this material harder to start?") — surfaced in the Progress panel (§30), not injected into the RAG chat prompt (keeping it out of the grounded-answer path entirely, per §21's non-negotiable rule).

---

## 15. Autonomy / Scaffolding — Critical Revision 10

**Autonomy score** — four equally-weighted, evidence-based components, ported directly:

```
autonomyScore = (initiativeRate + calibrationAccuracy + hintIndependence + proactiveReviewRate) / 4

initiativeRate       = self-initiated interactions / total interactions, per session, averaged
calibrationAccuracy  = 1 - min(|calibrationBias|, 1)                      // from §13
hintIndependence     = 1 - min(hintsOnMasteredConcepts / totalOnMasteredConcepts, 1)  // "mastered" = p_mastery >= 0.85
proactiveReviewRate  = reviews completed before FSRS's next_review_at due date / total reviews
```

**Trend** — needs ≥6 historical scores or defaults `stable`; compares mean of newest 5 vs. prior 5, `diff > 0.05 → improving`, `< -0.05 → declining`.

**Scaffolding tier — the deterministic support-level output the task asked for:**
```
score < 0.3             → HIGH_SUPPORT
0.3 <= score < 0.7       → STANDARD
score >= 0.7             → LOW_SUPPORT
```
(bounds corrected in the Revision 3 lock to match Tutor MCP's audited fade-tier values exactly — see §6A's `SCAFFOLDING_TIER_BOUNDS` provenance entry)
shifted by one tier in the trend's direction (clamped at the ends) — the same tier-plus-trend-shift idea as Tutor MCP's fade controller, simplified from its 3×3 table with four separately-wired output params down to **one output**: a scaffolding tier consumed by §17's action selector and by §21's prompt-context builder to decide how much structure/hand-holding Gemini is instructed to provide. Tutor MCP's `WebhookFrequency`/`ZPDAggressiveness`/`ProactiveReviewEnabled` outputs are dropped as SaaS-notification-specific (§36).

**The LLM implements the teaching style; the engine determines the required level** — `HIGH_SUPPORT` becomes a presentation instruction appended to the existing mode instruction (more intermediate steps, define terms before use), `LOW_SUPPORT` becomes "skip basics, offer an extension question" — exactly the same mechanism Revision 1 already used for mastery-based scaffolding (§21), now driven by the richer autonomy signal instead of raw mastery alone.

---

## 16. Adaptive difficulty — Critical Revision 13 (combined policy)

The Revision-1 hysteresis idea is preserved as the *base* policy and extended with IRT and PFA as modifiers, exactly as instructed ("preserve a strong idea, upgrade it").

```
1. Base band from BKT mastery, hysteresis-banded (UNCHANGED from Revision 1):
     rises: easy→medium at 0.45, medium→hard at 0.75
     falls: medium→easy at 0.35, hard→medium at 0.65
     evidence_count < 3 → pinned to "medium" (calibration phase)

2. PFA plateau modifier: if isPlateaued(concept) is true at the current band,
   nudge the band down ONE step, once — vary the practice rather than grinding
   an already-saturated difficulty. (This is PFA's one, clearly-defined role —
   see §8; it never touches p_mastery.)

3. IRT sanity modifier: if learner_ability.observation_count >= 3 for this subject
   and sigmoid(theta - b[band]) falls outside [0.40, 0.90], nudge the band one
   step toward center. Ignored entirely below 3 observations (§9.4).

4. Anti-oscillation ceiling: never move more than one band step per quiz,
   relative to the concept's previous quiz band, regardless of how many of
   steps 1-3 would otherwise fire. (UNCHANGED principle from Revision 1,
   now guarding a composite decision instead of a single formula.)
```

Three thresholds now exist in this neighborhood (`MASTERY_READY_THRESHOLD=0.70`, `MASTERY_ACHIEVED_THRESHOLD=0.85`, and the hysteresis bands `0.35/0.45/0.65/0.75`) — this is deliberate, not redundant: they answer three different questions (*"can the student start dependent material?"*, *"is this concept fully mastered?"*, *"what difficulty should the next question be?"*), and Tutor MCP's own drift toward unifying similar thresholds is exactly the kind of blurring this design avoids.

---

## 17. Pedagogical decision engine — Critical Revision 12 (first-class subsystem)

This is new, and it is what the task calls "a first-class Week 3 subsystem" — a deterministic function, `lib/pedagogy/select.ts::selectNextActivity(state, now) → {concept, action, difficulty, rationale}`, modeled on Tutor MCP's 7-stage regulation pipeline but **collapsed to what the audit explicitly recommended keeping** (phase FSM, concept-selector formulas, and the action-selector cascade — the three highest-value, cheapest-to-port pieces) while dropping what the audit flagged as multi-tenant/latency engineering with no payoff here (CAS-protected phase persistence, the goal-decomposer's versioned-JSON staleness tracking, the Bayesian info-gain diagnostic selector, the full 8-stage evidence-controller override machinery).

### 17.1 Phase (per subject, not global)

Three states, `DIAGNOSTIC | INSTRUCTION | MAINTENANCE`, stored on a small per-(student, subject) row (piggybacked onto `learner_ability`, adding a `phase` column — no new table needed):

```
DIAGNOSTIC  → INSTRUCTION : the student has answered at least one hint-free question on
                             every concept that appears in the currently selected documents
                             (a coverage rule, simplified from Tutor MCP's own coverage-over-
                             entropy criterion — the audit found their entropy-only design was
                             already superseded by a coverage rule in their own codebase, so we
                             adopt the version that's actually shipped, not the stale doc)
INSTRUCTION → MAINTENANCE : every concept in the current document selection has
                             p_mastery >= MASTERY_ACHIEVED_THRESHOLD (0.85)
MAINTENANCE → INSTRUCTION : any mastered concept's retrievability has dropped below
                             RETENTION_ROUTING_THRESHOLD (0.50)
```

### 17.2 Concept selection (phase-dispatched, direct port of the formulas — the audit's top recommendation)

```
DIAGNOSTIC : pick the concept (among those in the current document selection) with the
             FEWEST recorded interactions — a simple "least evidence first" rule, deliberately
             replacing Tutor MCP's Bayesian BKT-info-gain selector, which the audit judged
             not worth its complexity at this scale (marginal benefit over "ask about what
             we know least," per §36)
INSTRUCTION: argmax( relevance(c) * (1 - p_mastery(c)) )  over concepts that are "ready" (§6)
             where relevance(c) = 1.0 if c is in the currently selected documents, else 0.3
MAINTENANCE: argmax( (1 - retrievability(c)) * relevance(c) )  over mastered concepts
Tie-break: alphabetical by concept_key (deterministic — direct port)
```

**Priority overrides applied before the phase-formula runs** (a simplified merge of Tutor MCP's 5-rule gate into inline filters, per §36's SIMPLIFY recommendation):
1. Any concept with retrievability `< RETENTION_CRITICAL (0.30)` is force-selected (overrides the phase formula entirely) — the FSRS-critical-forgetting bypass.
2. Any concept with an `active` misconception is never excluded by anti-repeat, and is prioritized above the ordinary phase formula's second-ranked candidate.
3. Anti-repeat: exclude the concept selected in the immediately-previous activity **unless** rule 1 or 2 applies to it.

### 17.3 Action selection — the controlled output enum

Cascade, first match wins, evaluated **for the concept §17.2 selected**:

| # | Condition | Action |
|---|---|---|
| 1 | Retrievability `< 0.30` (critical forgetting) on an already-mastered concept | `SPACED_REVIEW` |
| 2 | Concept has an unready prerequisite (§6) | `PREREQUISITE_REMEDIATION` (targets the prerequisite, not the original concept) |
| 3 | Concept has an `active` misconception | `EXPLAIN` (with `focus: 'misconception'`, naming the tag) |
| 4 | `evidence_count < 3` (calibration phase) or the concept has never been seen | `EXPLAIN` (general) |
| 5 | `p_mastery >= 0.85`, evidence diverse (≥2 question types correct), transfer readiness `!= ready` | `TRANSFER_CHALLENGE` |
| 6 | `p_mastery >= 0.85` and transfer already `ready` | `DEEPEN` (open-ended extension, no quiz) |
| 7 | Most recent attempt on this concept was incorrect | `SIMPLIFY` (re-teach at lower scaffolding before re-quizzing) |
| 8 | `0.30 <= p_mastery < 0.85`, no override above fired | `QUIZ` at the band from §16 |
| 9 | (always available, not part of the cascade) student explicitly requests help mid-question | `HINT` |
| 10 | No document selected / student just chatting with no active concept | `CONTINUE` (plain RAG answer, §21) |

Rows 1–8 are what drives the "Quiz me" launcher's suggested next activity and the Progress panel's "what to do next" line; row 10 is the default for ordinary chat. `HINT` is a special always-available action during an in-progress quiz question, not part of the "next activity" cascade.

### 17.4 What Gemini controls vs. what this engine controls

Restated precisely in §33's Gemini-authority table — the short version: **this engine decides *which* concept and *which* action; Gemini decides *how* to execute that action in natural language** (the actual explanation text, the actual quiz question wording, the actual hint). Never the reverse.

---

## 18. Quiz architecture (Step 7) — REVISED

The generation pipeline shape from Revision 1 is unchanged (retrieve → generate → validate → persist → answer → evaluate → persist → update state); what's new is *what selects the target concept and difficulty* before retrieval starts:

```
selectNextActivity() [§17]  →  {concept, action, difficulty}
        ↓ (only when action ∈ {QUIZ, TRANSFER_CHALLENGE, SPACED_REVIEW, PREREQUISITE_REMEDIATION})
retrieve source chunks for that concept from the selected documents  [UNCHANGED lib/documents/retrieval.ts]
        ↓
ONE Gemini structured-generation call, difficulty/transfer-dimension passed as generation constraints
        ↓
lib/quiz/validation.ts  [UNCHANGED gates from Revision 1, §19]
        ↓
persist quizzes + quiz_questions (irt_difficulty_b assigned via the §9.2 fixed mapping,
  transfer_dimension defaulted by question_type, §12)
        ↓
student answers → evaluate → persist quiz_answers → §20's state-update pipeline
```

`GeneratedQuizQuestion` gains one field: `transferDimension?: "recall" | "application" | "transfer"` (defaults applied server-side if the model omits it, never trusted blindly if present — validated against the question_type/action-context combination that requested it).

Server-side answer-payload separation (student-visible vs. authoritative) is unchanged from Revision 1.

---

## 19. Quiz validation gates (Step 8) — UNCHANGED, one addition

All nine deterministic gates from Revision 1 stand unmodified. One addition: if the requesting action was `TRANSFER_CHALLENGE`, reject the generated question if its cited source chunk(s) are identical to the concept's original-explanation chunk(s) (the transfer-context check from §12) — falls back to a normal `APPLICATION` question with a logged warning rather than failing the whole quiz.

---

## 20. State update pipeline — Critical Revision 17

One authoritative path, transactional, for every interaction that produces evidence:

```
interaction arrives (quiz answer, explanation-requested, hint-requested, calibration-resolved, ...)
   ↓ validate (shape, ownership, question/quiz existence)
   ↓ persist immutable evidence → INSERT into learning_events (§25)
   ↓ compute deterministic updates, pure functions, no I/O inside each:
        bkt.applyBktUpdate()        [§7]
        pfa is NOT updated/stored — recomputed on read [§8]
        irt.updateTheta()           [§9]   (only for quiz answers, not every event type)
        retention.reviewCard()      [§10]  (only for quiz answers / explicit reviews)
        misconceptions.recordEvidence() [§11]  (only on incorrect answers with a proposed tag)
        transfer counters increment  [§12]  (only for the relevant question_type)
   ↓ persist all derived state in ONE transaction (learner_concept_state upsert +
     learner_ability upsert + misconceptions upsert) — all-or-nothing
   ↓ recompute pedagogical recommendation [§17] for the response payload (NOT persisted —
     it's derived fresh on every call, same "don't persist what's derivable" rule as §23)
```

**Idempotency — simplified deliberately from the source.** Tutor MCP has a full CAS/replay-table idempotency system (`narrative_mutations`, per-tool idempotency keys) built for a multi-process server under retry/replay conditions. That's classified NOT SUITABLE for a single-process Next.js app talking directly to Postgres (§36). Instead: quiz submission is idempotent *by construction* — `quiz_answers` has `UNIQUE(quiz_id, question_id)`, and `quizzes.status` transitions to `submitted` exactly once (a resubmit against an already-`submitted` quiz is rejected with the original result returned, not silently reapplied). For lower-stakes events (hint requested, explanation requested), an optional client-supplied `idempotencyKey` column with `UNIQUE(student_id, idempotency_key) WHERE idempotency_key IS NOT NULL` on `learning_events` is the entire mechanism — one nullable column and one partial unique index, not a subsystem.

**Transactions, not distributed consistency:** a single Postgres transaction wrapping the derived-state writes is sufficient — there is no multi-node consistency problem to solve here, so Tutor MCP's compare-and-swap phase persistence and evidence-snapshot-reuse machinery (built for concurrent API replicas) is dropped entirely, not simplified (§36: NOT SUITABLE).

**Replayability/auditability:** because `learning_events` is immutable and every derived-state write is a pure function of accumulated events, `learner_concept_state` can in principle be recomputed from scratch by replaying `learning_events` in order — this is not built as a feature in v1, but the design doesn't preclude it (no derived-state write ever discards the event that caused it).

---

## 21. Personalized chat & RAG integration — Critical Revision 14 — REAFFIRMED, single path

Unchanged principle from Revision 1, now explicitly reaffirmed against the temptation the new subsystems introduce: **there is still exactly one RAG path.** `answerWithRag()` keeps its Revision-1 signature (one new optional dependency: a learner-context fetch). The pedagogical engine's selected `action` (§17.3) — `EXPLAIN`/`SIMPLIFY`/`DEEPEN`/`CONTINUE`/`HINT` — becomes one more presentation instruction layered onto the *existing* `modeInstruction()` output in `rag-prompt.ts`, exactly like Revision 1's mastery-based scaffolding did, now driven by the richer engine instead of raw mastery alone.

```
FACT AUTHORITY:        Week 2 retrieval + citations (UNCHANGED, untouched code)
LEARNER AUTHORITY:     the learning engine (§7-17) — decides HOW to teach
LANGUAGE/EXPLANATION:  Gemini — decides the WORDS
VALIDITY:              server-side validation (§32) — decides what's allowed to persist
```

The rule from Revision 1 stands unchanged and is now backed by more machinery that could tempt violating it: **learner context never adds, removes, or overrides a fact from retrieved sources; if retrieval is insufficient, the refusal path runs exactly as in Week 2 and no pedagogical/personalization content is even computed for that turn.**

---

## 22. Bounded learner-context builder — Step 11 — REVISED (degradation cascade)

Extends Revision 1's bounded-context idea with the one genuinely valuable pattern from the Tutor MCP audit: a **hard byte budget with graduated degradation**, rather than an unbounded "include everything relevant" list.

`LEARNER_CONTEXT_BUDGET = 1,500 characters` (small relative to Tutor MCP's 40 KB, because ours is injected into a prompt that already carries Week 2's own 12,000-character evidence budget — the two budgets are independent and this one only needs to carry pedagogy, not facts).

**Always included** (small, fixed): profile preferences (style/pace/level), the pedagogical engine's selected `action` for this turn, current scaffolding tier (§15).

**Conditionally included, in this exact drop order when the budget is exceeded:**
1. Top 2 weak concepts (by revision-ranking, §23) — dropped first.
2. Active misconceptions relevant to the current concept (max 1) — dropped second.
3. One confirmed narrative-memory observation relevant to the current subject — dropped third.
4. Current concept's mastery/retention numbers — dropped last, only if literally nothing else fits.

**Never included:** raw `learning_events`, the full `learner_concept_state` table, other students' data (n/a), embeddings, pending (unconfirmed) narrative memories, calibration records in raw form (only the derived `bias` scalar, if actionable, ever surfaces — and only in the Progress panel, never in the RAG prompt, per §14).

---

## 23. Revision recommendations (Step 13) — REVISED ranking inputs

Same deterministic-ranking principle as Revision 1 (Gemini may phrase, never selects), with the ad hoc weight formula replaced by the richer signals now available:

```
priority(concept) =
    0.35 * (1 - p_mastery)                                  // low mastery
  + 0.25 * retentionUrgency(concept)                        // 0 / 0.5 / 1.0 for none/WARNING/CRITICAL, §10.3
  + 0.20 * (misconception status == 'active' ? 1 : 0)       // recurring, confirmed error pattern (§11)
  + 0.10 * (pfaPlateaued(concept) ? 1 : 0)                  // stuck, not just wrong (§8)
  + 0.10 * relevance(concept)                               // in currently selected documents
```
Concepts with `evidence_count == 0` are still excluded entirely (nothing observed yet), exactly as Revision 1 specified. Output template unchanged: *"Review **{displayName}** — mastery {round(p_mastery*100)}%, {status line drawn from whichever signal fired}."* Still **not persisted** — computed on demand, per Revision 1's original DB-reduction reasoning, which the task's re-review explicitly asked to reconsider and which still holds (§27).

---

## 24. Learning analytics (Step 14) — REVISED metric list

All Revision-1 metrics stand; new ones derivable from the expanded state, still every number traceable to a query:

- **Retention health** — count of concepts by urgency tier (§10.3), direct `learner_concept_state` aggregate.
- **Calibration trend** — rolling bias over time, `calibration_records` aggregate (surfaced only in Progress, never in chat).
- **Autonomy score + trend** — §15, computed on read.
- **Transfer coverage** — count of concepts with `ready` transfer status vs. total mastered concepts.
- **Active misconceptions** — direct `misconceptions WHERE status='active'` read.

No new fabricated metrics; every one above is a read over §27's tables.

---

## 25. Event catalog — Critical Revision 16

`learning_events` is the single immutable evidence log for the whole learner-intelligence subsystem (sessions included — matching how the audit found Tutor MCP itself structures it: a durable session-boundary row plus an append-only interaction stream referencing it).

| Event type | Concept ref? | Quiz/question ref? | Key metadata fields | Why it's needed |
|---|---|---|---|---|
| `SESSION_STARTED` | no | no | `subject` | Session-lifecycle boundary (§17.1's phase state is per session-scoped subject) |
| `SESSION_ENDED` | no | no | `end_reason ∈ {explicit, superseded, stale_timeout}` | Decision 2's explicit lifecycle (§31) |
| `QUESTION_ASKED` | maybe | no | `mode`, `selfInitiated` | Feeds initiative rate (§15), diagnostic-phase coverage (§17.1) |
| `QUIZ_STARTED` | yes | quiz | `action`, `difficulty` | Audit trail for why this quiz was generated |
| `QUIZ_ANSWERED` | yes | question | `correct`, `responseTimeMs`, `hintsUsed` | The core BKT/PFA/IRT/FSRS evidence event |
| `QUIZ_COMPLETED` | no | quiz | `score` | Session/episodic rollup trigger |
| `HINT_REQUESTED` | yes | question | — | Feeds hint-independence (§15) |
| `CONFIDENCE_REPORTED` | maybe | maybe | `predicted` | Opens a `calibration_records` row (§13) |
| `REVIEW_COMPLETED` | yes | maybe | `wasProactive` | Feeds proactive-review rate (§15), FSRS review (§10) |
| `TRANSFER_ATTEMPTED` | yes | question | `dimension`, `score` | Transfer counters (§12) |
| `MISCONCEPTION_OBSERVED` | yes | question | `tag`, `proposedByLlm: true` | Candidate evidence only (§11) — never authoritative by itself |

Deliberately **not** created as separate event types (avoiding the "useless analytics noise" the task warned against): a bare "page viewed" or "document selected" event — those aren't learning evidence and don't feed any algorithm above.

**Design note vs. the source:** Tutor MCP itself uses one flatter `interactions` table with an `activity_type` column rather than a dedicated event-type enum, deriving most of what we call distinct event types via query instead. Our richer, explicit enum is a deliberate choice to match the task's specific request for a documented event catalog — it costs one more `CHECK` constraint, not real complexity, and makes the audit trail self-describing without needing to know which `activity_type` values imply which downstream effect.

---

## 26. Data provenance summary (cross-cutting, answers §11's ask directly)

| Data | Provenance | Who may write it |
|---|---|---|
| `student_profiles.*` | `user_declared` | Student only |
| `learner_concept_state.p_mastery/stability/theta/retention_*` | `calculated` | Only the deterministic updaters in `lib/learning/*` |
| `learning_events.*` | `calculated` (fact of occurrence) | Any validated interaction-recording code path; never edited/deleted |
| `misconceptions.tag/description` (candidate stage) | `llm_suggested` | Gemini, via structured evaluation output only |
| `misconceptions.status/evidence_count` | `calculated` | Only `lib/learning/misconceptions.ts::recordEvidence` |
| `narrative_memories.content` (pending) | `llm_suggested` | Gemini |
| `narrative_memories.status→confirmed` | `calculated` (corroboration rule) | Only the deterministic promotion check, §5.1 |
| `calibration_records.predicted` | `user_declared` | Student's self-rating |
| `calibration_records.actual/delta` | `calculated` | Deterministic resolution against quiz outcome |

---

## 27. Database design — full re-review (Step 15)

The task explicitly forbade both artificially preserving "9 tables" and reflexively ballooning to 20+. Working through every candidate:

**Kept as its own table** (12 total, plus Week 2's untouched `documents`/`document_chunks`):

```sql
-- 1. student_profiles — unchanged from Revision 1 (§4)

-- 2. learning_concepts — §6
-- 3. concept_prerequisites — §6

-- 4. learner_concept_state — the big consolidation table
learner_concept_state (
  student_id uuid FK cascade, concept_id uuid FK restrict,
  -- BKT (§7)
  p_mastery float CHECK (p_mastery between 0.02 and 0.98),
  evidence_count int, correct_count int, incorrect_count int,
  -- FSRS retention (§10) — separate columns, same row, never conflated with p_mastery
  stability float, retention_difficulty float, last_reviewed_at timestamptz,
  next_review_at timestamptz, reps int, lapses int,
  card_state text CHECK IN ('new','learning','review','relearning'),
  -- Transfer counters (§12) — plain integers, no separate table
  recall_attempts int default 0, recall_successes int default 0,
  application_attempts int default 0, application_successes int default 0,
  transfer_attempts int default 0, transfer_successes int default 0,
  updated_at timestamptz,
  PRIMARY KEY (student_id, concept_id)
)
-- PFA is NOT a column here — recomputed on read from correct_count/incorrect_count
-- and the recent-events replay (§8). This is the direct, explicit answer to the
-- "avoid a second redundant mastery score" instruction.

-- 5. learner_ability — §9.1 (IRT theta, per student+subject) + §17.1's phase column
learner_ability (
  student_id uuid FK cascade, subject text,
  theta float default 0, observation_count int default 0,
  phase text CHECK IN ('DIAGNOSTIC','INSTRUCTION','MAINTENANCE') default 'DIAGNOSTIC',
  phase_changed_at timestamptz, updated_at timestamptz,
  PRIMARY KEY (student_id, subject)
)

-- 6. calibration_records — §13 (the one mutable, non-event student-state table)

-- 7. misconceptions — §11 (real lifecycle, stronger than the source)

-- 8. learning_events — §25 (immutable log, all algorithmic evidence)

-- 9. learning_sessions — extended for Decision 3's explicit lifecycle
learning_sessions (
  id uuid PK, student_id uuid FK cascade, subject text,
  status text CHECK IN ('active','ended') default 'active',
  started_at timestamptz, ended_at timestamptz null,
  end_reason text CHECK IN ('explicit','superseded','stale_timeout') null,
  last_active_at timestamptz,   -- bumped on every learning_events insert; the sole input to staleness detection
  concepts_touched uuid[] default '{}', summary text null,   -- summary is llm_observed, episodic (§5)
  UNIQUE (student_id) WHERE status = 'active'                 -- one active session per student, mirrors the source
)

-- 10. narrative_memories — §5.1
narrative_memories (
  id uuid PK, student_id uuid FK cascade, content text CHECK (length(content) <= 300),
  status text CHECK IN ('pending','confirmed') default 'pending',
  corroborated_by uuid null REFERENCES narrative_memories(id),  -- links the confirming observation
  created_at timestamptz
)

-- 11. quizzes — unchanged from Revision 1, + subject/action/target_concept_id columns
--     recording WHY this quiz was generated (audit trail for §17's decision)
-- 12. quiz_questions — unchanged from Revision 1, + concept_id FK, irt_difficulty_b float,
--     transfer_dimension text CHECK IN ('recall','application','transfer')
-- 13. quiz_answers — unchanged from Revision 1
```

**Deliberately NOT created**, with the specific reasoning the task asked for:

| Candidate | Why not |
|---|---|
| `quiz_attempts` | Still folded into `quizzes.status`/`submitted_at`/`score` — no retake modeling requested, unchanged from Revision 1's reasoning |
| `revision_recommendations` | Still fully derivable on demand (§23) — re-reviewed as instructed, conclusion unchanged |
| A dedicated PFA table | The state it needs already exists as BKT's counters (§8) |
| A dedicated transfer table | Six integer columns on `learner_concept_state` are sufficient (§12) |
| A dedicated autonomy/metacognition table | Both are pure functions computed on read from `learning_events` + `calibration_records` (§14, §15) — persisting them would just be an unrequested cache |
| Separate `pedagogical_snapshots` audit table (Tutor MCP has one) | Classified SIMPLIFY in §36 — for a single learner, `learning_events.metadata` already carries enough of the "why" (the `action`/`difficulty` fields on `QUIZ_STARTED`) to reconstruct a decision after the fact without a parallel audit table; add one later only if debugging the pedagogical engine in production turns out to need it |

**Net: 12 new tables** (up from Revision 1's 9, for a genuinely larger algorithmic scope — this is not "artificially preserving 9," it's the honest count after folding everything foldable into `learner_concept_state`/`learner_ability` and rejecting everything that's cheaply derivable instead of stored).

**Unchanged, reused conceptually as Week 3's own migration 001 (fresh project, §0):** `documents`, `document_chunks`, `match_document_chunks` RPC, HNSW index, private Storage bucket — copied schema, independent infrastructure.

---

## 28. API design (Step 16) — REVISED routes

Extends Revision 1's route table; unchanged rows omitted for brevity, only new/changed rows shown:

| Route | Method | Input | Output | Gemini? | DB effects |
|---|---|---|---|---|---|
| `/api/learning/session` | POST | `{action: 'start'\|'end', subject?}` | Current session state | No | `learning_sessions` upsert, stale-session auto-close check (Decision 3) runs here on every call |
| `/api/learning/next-activity` | GET | `{subject}` | `{concept, action, difficulty, rationale}` — §17's output | No | reads only |
| `/api/learning/calibration` | POST | `{predicted}` then later `{recordId, actual}` | Opened/resolved `CalibrationRecord` | No | `calibration_records` insert/update |
| `/api/quiz/generate` | POST | unchanged shape, now internally calls `/learning/next-activity` server-side rather than trusting a client-supplied topic | unchanged | 1 call | `learner_concept_state`/`learner_ability` reads, `learning_concepts` upsert, `quizzes`+`quiz_questions` insert |
| `/api/quiz/[id]/submit` | POST | unchanged | unchanged, now also returns updated retention/transfer/misconception deltas | 0–N calls | full §20 transactional update |
| `/api/learning/progress` | GET | — | Extended per §24; now shaped per §30 — `{concepts: [{conceptId, displayName, presentationStage, explanation: string[], transferLabel?}], reviewsDue, weakConcepts, strongConcepts, recentQuizPerformance, activeMisconceptions, calibration? (present only if actionable, §13), scaffolding: 'high'\|'standard'\|'low', ...raw p_mastery/theta/etc. fields retained for internal/analytics use but never rendered by the Progress panel, §30.5}` | No | reads only |

All other Revision-1 routes (`/api/profile`, `/api/rag` extension, `/api/recommendations`) are unchanged in contract.

---

## 29. Service/module structure (Step 17) — REVISED

```
lib/learning/
  profile.ts              [unchanged]
  concepts.ts              normalizeConceptKey() + upsert + prerequisite edges/cycle-check (§6)
  bkt.ts                    applyBktUpdate() — pure (§7)
  pfa.ts                     pfaScore()/isPlateaued() — pure, reads events, writes nothing (§8)
  irt.ts                      updateTheta() — pure (§9)
  retention.ts                 fsrsReview() — pure (§10)
  misconceptions.ts             recordEvidence()/resolveIfClear() — the sole status-writer (§11)
  transfer.ts                    counters + readiness ladder — pure (§12)
  calibration.ts                   bias()/isActionable() — pure (§13)
  metacognition.ts                  detectMirrorPattern() — pure (§14)
  autonomy.ts                        computeAutonomyScore()/scaffoldingTier() — pure (§15)
  events.ts                           append-only insert helpers (§25)
  memory.ts                            narrative-memory read/corroboration-check (§5.1)
  context-builder.ts                    bounded LEARNER CONTEXT + degradation cascade (§22)
  recommendations.ts                     ranking (§23)
  analytics.ts                            aggregates (§24)
  olm.ts                                   deriveMasteryStage() / explainConceptStatus() — pure,
                                            zero Gemini calls, the sole source for §30's Progress panel
  constants.ts                              LEARNING_CONFIG — the single source of every tunable
                                             value in this subsystem (§6A)

lib/pedagogy/
  phase.ts                  phase FSM (§17.1)
  select-concept.ts          phase-dispatched concept selection + priority overrides (§17.2)
  select-action.ts            the 10-action cascade (§17.3)
  difficulty.ts                 combined BKT+IRT+PFA+hysteresis policy (§16)

lib/quiz/
  generation.ts, validation.ts, evaluation.ts   [Revision 1, extended per §18-19]

lib/personalization/
  prompt-context.ts        merges §17's action + §15's scaffolding tier into rag-prompt.ts (§21)
```

Same file-per-concern discipline as Week 2's own `lib/documents/` layering — every function above is pure and independently testable except the thin DB-access wrappers in `events.ts`/`concepts.ts`, matching the dependency-injection pattern `lib/documents/rag.ts` already established.

---

## 30. UI evolution & the Learning Progress / Open Learner Model panel (Step 18) — Decision 3 (LOCKED)

**Locked: yes, build a visible learner-model/progress surface — but the Week 2 document/chat workspace remains the primary product surface.** This section replaces Revision 2's brief sketch with a full specification, per the open-learner-model principle: the student should be able to inspect meaningful parts of the model used to adapt their teaching, without the product becoming a generic LMS dashboard.

### 30.1 Where it lives

No new page, no router, no restructuring of the two-pane shell (unchanged constraint from Revision 1/2). The Progress panel is the same sibling `<section>` added to the document rail described in Revision 1/2, now fully specified below. A small icon-button in `Header` (profile-setup entry point, unchanged from Revision 1) opens it as a lightweight overlay/drawer, keeping the primary chat/quiz surface untouched when it's closed.

### 30.2 Presentation stages — the evidence/confidence gate

Raw probabilities are never shown to the student. The **internal system retains full precision** (`p_mastery` as a float, `theta`, FSRS `stability`, etc. — all queryable internally and usable for the pedagogical engine), but the student-facing surface renders only one of six deterministic stages, derived by a pure function, `lib/learning/olm.ts::deriveMasteryStage(state)`:

```
NEW           — evidence_count == 0 (never attempted)
REVIEW_DUE    — card_state != 'new' AND retrievability(state) < RETENTION_WARNING (0.40)
                (overrides the mastery-based stages below whenever it applies — a concept that
                was progressing but is now decaying is more actionable-right-now than its
                mastery number alone suggests)
LEARNING      — evidence_count > 0 AND (evidence_count < MIN_EVIDENCE_FOR_ADAPTIVE (3)
                OR p_mastery < 0.40)
DEVELOPING    — evidence_count >= 3 AND 0.40 <= p_mastery < MASTERY_READY_THRESHOLD (0.70)
PROFICIENT    — evidence_count >= 3 AND MASTERY_READY_THRESHOLD <= p_mastery < MASTERY_ACHIEVED_THRESHOLD (0.85)
MASTERED      — evidence_count >= 3 AND p_mastery >= MASTERY_ACHIEVED_THRESHOLD (0.85)
```

This is a total, deterministic, boundary-tested function (§34) over already-authoritative state — never a separate judgment call, never Gemini-derived. `REVIEW_DUE` can only ever apply to a concept whose `card_state != 'new'`, which by construction means it already passed through `LEARNING`/`DEVELOPING`/`PROFICIENT`/`MASTERED` at least once — so there's no conflict with `NEW`/early `LEARNING` concepts, which have no FSRS review scheduled yet.

### 30.3 "Why" — a deterministic explanation, not a generated one

Every displayed stage is paired with 1–3 short factual bullet lines, produced by a second pure function, `lib/learning/olm.ts::explainConceptStatus(state, misconception?, transferLabel?)` — **template-based, zero Gemini calls**, built only from already-stored fields:

```
"{evidence_count} practice attempt(s)"                                    — whenever evidence_count > 0
"{n} recent error(s) involving {misconception.description}"                — only if an ACTIVE misconception exists on this concept
"Review recommended — retention has dropped since last practiced"          — only when stage == REVIEW_DUE
"Successfully applied in a new context"                                    — only when transferLabel == 'ready'
"Not yet studied"                                                          — only when stage == NEW
```
Matching the task's own example exactly:
> **Rabin-Karp — Developing**
> - 3 practice attempts
> - 2 recent errors involving rolling hash
> - Review recommended

### 30.4 What's shown, and the evidence gates on each

| Element | Shown when | Hidden when |
|---|---|---|
| Concept mastery stage + explanation | Always, for every concept with ≥1 documented interaction (§30.2/30.3) | Never — even `NEW` is meaningful information |
| Reviews due | Always — a direct list of `REVIEW_DUE`-stage concepts | Empty list rendered as "nothing due," not omitted |
| Weak / strong concepts | Stage-based (`LEARNING`/`DEVELOPING` = weak, `MASTERED` = strong) | Concepts still at `NEW` are excluded from both lists — no evidence to call them either |
| Recent quiz performance | Always, from `quiz_answers`/`quizzes` aggregates | — |
| Recurring misconceptions | Only `status='active'` rows (§11) | `candidate`-status misconceptions are **never shown** — an unconfirmed LLM guess is not the student's business until it's evidenced |
| Transfer performance | Only for concepts with `transfer_attempts >= 1` | Concepts with zero transfer attempts show no transfer line at all — never a misleading "N/A" |
| Confidence / calibration | Only when `isActionable(bias, sampleCount)` from §13 is true (`sampleCount >= 5`) | Below 5 samples, the entire calibration section is omitted, not shown with a placeholder |
| Support/scaffolding level | Always, as one plain-language label only: *"Extra guidance right now"* / *"Standard support"* / *"Working independently"* (§15's three tiers) | The raw 0–1 autonomy score is never rendered |

This directly implements the task's own example: **"Rabin-Karp — Developing" rather than "Rabin-Karp — 43.721%."**

### 30.5 What is never exposed, anywhere in this panel

Raw system prompts, hidden answer keys (unchanged invariant from §18/§32 — quiz `correct_answer` never reaches the client pre-submission, and never appears here either), security/session metadata, internal chain-of-thought (not applicable — this app never surfaces one), and raw BKT/IRT internals (`p_mastery` as a precise float, `theta`, `P(T)/P(S)/P(G)`, FSRS `stability`/`retention_difficulty`, the raw autonomy score, the raw calibration bias number). The `/api/learning/progress` payload (§28) may still *carry* these raw fields for internal/analytics use — the frontend component simply never renders them.

### 30.6 Remaining Revision 1/2 additions, unchanged

- **Quiz results screen** still gains the one-line optional calibration prompt ("How confident were you? 1–5") after a short-answer question, feeding §13.
- **"End Session" control** — a small, separate affordance from Header's existing "New chat" (Decision 2, §31).

---

## 31. Session lifecycle — Decision 2 (LOCKED)

**`STALE_SESSION_MINUTES = 90` — locked.** Rationale, verbatim from the decision: this is a study application; a learner may spend significant time reading a PDF, working a problem, or otherwise away from the interaction surface without having stopped studying. Ninety minutes is deliberately generous — see the governance note below on what this number is and isn't claiming.

- A learning session starts on the first **meaningful learning interaction**: `QUESTION_ASKED` with a document selected, `QUIZ_STARTED`, or an explicit "Start learning session" action — plain navigation/UI clicks never start one, and never insert a `learning_events` row.
- **Explicit "End Session" is authoritative** — a direct, unambiguous signal, always trusted immediately, `end_reason='explicit'`.
- **A new explicit learning session may close the previous one** — starting a fresh session auto-closes any still-open prior session with `end_reason='superseded'`; a student is never left with two "active" sessions.
- **Stale detection is a recovery mechanism, not a precise claim about when the learner actually stopped.** It exists solely so an abandoned session (browser closed without clicking "End Session," device died, etc.) doesn't stay "active" forever and quietly corrupt the anti-repeat window (§17.2) or initiative-rate tracking (§15) on the student's next visit. It is never presented to the student as "you stopped studying at exactly 90 minutes," and no part of the pedagogical engine treats the exact staleness boundary as pedagogically meaningful — only "this session object is no longer trustworthy as 'currently open'" is meaningful.
- Checked server-side on every `/api/learning/session` and `/api/learning/next-activity` call: if the active session's `last_active_at` (bumped on every `learning_events` insert while that session is open — the session's **last meaningful activity timestamp**, preserved exactly, never estimated or backdated) is older than `STALE_SESSION_MINUTES = 90`, it is closed safely with a **system-derived reason, `end_reason='stale_timeout'`**, before anything else in that request runs.
- **Browser unload/tab-close is never treated as authoritative** — no `beforeunload`/`visibilitychange` handler closes a session; staleness is detected only lazily, server-side, on the next request that touches session state.
- **"New Chat" does NOT close the learning session, does NOT reset long-term learner state, and does NOT create artificial learning evidence.** Clicking it clears only the client-side `messages` array (Week 2's existing, well-understood semantic) — it triggers zero `learning_events` inserts, zero `learner_concept_state`/`learner_ability` writes, and zero session-lifecycle transitions. Justification: a learning session is a broader analytical boundary spanning the phase FSM (§17.1), the anti-repeat window (§17.2), and initiative-rate tracking (§15); conflating it with a lightweight chat-clear would silently reset pedagogical state every time a student clears their chat window for an unrelated reason (e.g., starting a new topic within the same study session), actively working against the anti-oscillation goals built into §16/§17. A separate, explicit "End Session" control keeps the two concerns independently controllable.

---

## 32. Security / trust boundaries (Step 20) — REVISED authoritative-owner table

Extends Revision 1's table (unchanged rows omitted) with the new subsystems' boundaries — this is the concrete answer to "Gemini authority," restated compactly again in §33:

| Data/decision | LLM may propose | LLM may NOT | Authoritative writer |
|---|---|---|---|
| BKT `p_mastery`, `P(T)/P(S)/P(G)` | — | Anything | `lib/learning/bkt.ts` only |
| IRT `theta` | — | Anything | `lib/learning/irt.ts` only |
| FSRS `stability`/`next_review_at` | — | Anything | `lib/learning/retention.ts` only |
| Misconception candidate `{tag, description}` | Yes | Set `status`/`evidence_count` | `lib/learning/misconceptions.ts` |
| Narrative memory content | Yes (pending only) | Promote to `confirmed` | Deterministic corroboration check (§5.1) |
| Transfer/short-answer score | Yes, as `evidence_trust: 'llm_graded'` | Claim `trusted` status (n/a — no evaluator tier exists to claim) | `lib/quiz/evaluation.ts` applies the score; §12's readiness ladder decides what it means |
| Phase (`DIAGNOSTIC`/`INSTRUCTION`/`MAINTENANCE`) | — | Anything | `lib/pedagogy/phase.ts` |
| Next concept/action/difficulty | — | Anything | `lib/pedagogy/select-*.ts`, `difficulty.ts` |
| Quiz correctness (MCQ) | — | Anything | Deterministic string compare |
| Client-submitted quiz score/mastery delta | — | Ever be trusted | Server re-evaluates from stored `correct_answer` every time (unchanged from Revision 1) |

All of Revision 1's other boundaries (citation authority, document prompt-injection defenses, secret handling) are unchanged and restated in §33/§36.

---

## 33. Gemini call budget & authority (Step 22) — REVISED

**Call budget** — unchanged from Revision 1's table, with one addition: misconception-candidate proposal and transfer-context scenario generation are **not separate calls** — they're additional structured fields on the *existing* quiz-generation call and the *existing* short-answer-evaluation call respectively. Zero new Gemini call sites are introduced by this entire revision; every new algorithm (BKT, PFA, IRT, FSRS, calibration bias, autonomy, phase FSM, concept/action selection) is pure, deterministic, and Gemini-free.

**GEMINI AUTHORITY — CAN:**
- Propose a misconception candidate label/description (never its status)
- Author quiz question text/options/explanations (validated deterministically before persist, §19)
- Grade short-answer responses, returning structured evidence (never applying it directly, §9's/§20's pipeline applies it)
- Propose a narrative-memory candidate observation (pending only, §5.1)
- Propose a transfer-challenge scenario (validated against the transfer-context check, §19)
- Phrase revision recommendations and the metacognitive mirror message (cosmetic only, never selects them)
- Adjust explanation tone/depth per the action + scaffolding tier it's handed (§21)

**GEMINI AUTHORITY — CANNOT:**
- Write, adjust, or override any BKT/IRT/FSRS/calibration-bias/autonomy value
- Decide phase, next concept, next action, or difficulty band
- Mark a misconception `active`/`resolved`, or a narrative memory `confirmed`
- Mark transfer readiness `ready`/`blocked`
- Determine MCQ correctness
- Override, add, or suppress a citation, or answer without sufficient retrieved evidence

---

## 34. Testing strategy (Step 21) — REVISED, expanded

All Revision-1 test cases stand (mastery-update math is now BKT-shaped instead of EMA-shaped, but the "pure function, exact expected numbers" testing style is identical). New cases:

| Area | Acceptance criterion |
|---|---|
| BKT math | Reproduce the audit's hand-verified numbers exactly: `{0.5, 0.3, 0.05, 0.1, 0.2}` → correct gives `0.8318`, incorrect gives `0.3722` (to 4 decimals) |
| BKT clamping | A sequence of many consecutive correct answers never pushes `p_mastery` above `0.98`; many incorrect never below `0.02` |
| PFA | `pfaScore(0,0) → probability exactly 0.5`; a sequence with `max adjacent delta < 0.025` over the last 4 points is flagged plateaued, a sequence with any larger jump is not |
| IRT | A single correct response from `theta=0` against `b=1` (medium) moves theta into `(0,1)`, never reaches it or the `[-4,4]` boundary; `observationCount=0` uses the full unregularized pull, `observationCount=20` moves theta far less for the same response |
| Retention scheduling | `retrievability(elapsedDays=10, stability=1) ≈ 0.5468`; a lapse (`Again` on a `review`-state card) increases `lapses` and recomputes stability via the forget formula, never the recall formula |
| Prerequisite cycle detection | Inserting an edge that would close a cycle is rejected with the exact cycle path in the error; a valid DAG insert succeeds |
| Prerequisite readiness | A concept with one prerequisite at `p_mastery=0.69` is not ready; at `0.70` it is (boundary inclusive) |
| Misconception reinforcement/resolution | Two incorrect answers with the same tag flips `candidate→active`; three subsequent interactions with no recurrence flips `active→resolved`; a single incorrect answer never reaches `active` alone |
| Transfer | `not_attempted→attempted→ready` transitions match the exact rule in §12; a fresh failing transfer attempt drops `ready→attempted` immediately |
| Calibration | `isActionable` is false below 5 samples regardless of bias magnitude; true at 5+ samples with `|bias|>=0.25` |
| Scaffolding | Autonomy score exactly at a tier boundary (`0.35`, `0.70`) resolves deterministically to the documented side; trend shift never pushes past `HIGH_SUPPORT`/`LOW_SUPPORT` |
| Pedagogical decisions | Given a fixed `learner_concept_state` fixture, `selectNextActivity()` returns the exact expected `{concept, action, difficulty}` for each of the 10 cascade rows in §17.3, tested independently |
| Event idempotency | Two calls with the same `idempotencyKey` and same payload produce one row; same key with a different payload is rejected |
| Duplicate quiz submissions | Submitting an already-`submitted` quiz a second time returns the original result unchanged, applies zero additional mastery/retention updates |
| Transactional learning-state updates | A forced mid-transaction failure (test-injected) leaves `learner_concept_state` unchanged — no partial BKT-updated-but-FSRS-not-updated state ever persists |
| Presentation-stage derivation (§30.2) | Boundary values (`p_mastery` exactly `0.40`/`0.70`/`0.85`, `evidence_count` exactly `3`) resolve deterministically to the documented side of each stage; a `card_state != 'new'` concept with retrievability just under `0.40` returns `REVIEW_DUE` regardless of its mastery stage; `evidence_count == 0` always returns `NEW` regardless of any other field |
| Stale-session recovery (§31) | A session with `last_active_at` exactly `90` minutes old is not yet stale; one second past 90 minutes triggers `stale_timeout` on the next request; "New Chat" inserts zero rows into `learning_events`/`learner_concept_state`/`learning_sessions` |
| Config governance (§6A) | Every named constant is read from `LEARNING_CONFIG` in tests too (no test hardcodes a duplicate literal) — a test asserting `LEARNING_CONFIG.version === 1` guards against a silent in-place edit |
| **Plus, unchanged from Revision 1:** all Week 2 RAG/citation/grounding regression tests, re-run with a non-empty §22 learner-context block, asserting byte-identical grounding/citation output |

---

## 35. Phase plan (Step 23) — REVISED, dependency-ordered per the task's suggested sequence

| Phase | Goal | Key new files | Migrations | Acceptance gate | Rollback risk |
|---|---|---|---|---|---|
| **0** | Fresh Week 3 workspace + fresh Supabase project | fork per §0 | `001_document_assistant.sql`, `002_semantic_retrieval.sql` (Week 2 schema, new project) | Week 2 baseline (56/0, lint/build PASS) reproduces against the *new* project after re-uploading a test PDF | None |
| **1** | Week 2 replication verified + learner profile + event ledger | `003_student_profile.sql`, `004_learning_events.sql`, `lib/learning/{profile,events}.ts` | student_profiles, learning_events, learning_sessions | Profile CRUD + event insert/idempotency round-trip | Low |
| **2** | Concept registry + prerequisite graph | `005_concepts.sql`, `lib/learning/concepts.ts` | learning_concepts, concept_prerequisites | Normalization tests (§6) + cycle-rejection test | Low |
| **3** | BKT + PFA core | `006_learner_concept_state.sql`, `lib/learning/{bkt,pfa}.ts` | learner_concept_state (BKT+PFA columns only) | Exact-number BKT tests (§34) pass | Low — no external routes touch this yet |
| **4** | IRT + adaptive difficulty | `007_learner_ability.sql`, `lib/learning/irt.ts`, `lib/pedagogy/difficulty.ts` | learner_ability | IRT boundary/regularization tests + §16's combined-policy tests | Low |
| **5** | Retention/review engine | extend `006` with FSRS columns, `lib/learning/retention.ts` | `008_retention_columns.sql` | Retrievability/scheduling tests match §34's numbers | Low |
| **6** | Misconceptions + transfer + calibration | `009_misconceptions.sql`, `010_calibration.sql`, extend `006` with transfer columns | misconceptions, calibration_records | Lifecycle/readiness/actionability tests (§34) | Low |
| **7** | Autonomy/scaffolding + memory layers | `011_narrative_memories.sql`, `lib/learning/{autonomy,metacognition,memory}.ts` | narrative_memories | Autonomy formula + corroboration-promotion tests | Low |
| **8** | Pedagogical decision engine | `lib/pedagogy/{phase,select-concept,select-action}.ts` | none (uses `learner_ability.phase`) | All 10 action-cascade rows tested against fixtures (§34) | Low — pure functions, no routes wired yet |
| **9** | Adaptive grounded quiz system | `012_quiz_engine.sql`, `013_quiz_answers.sql`, `lib/quiz/*` | quizzes, quiz_questions, quiz_answers | §19/§34's quiz validation + tampered-submission tests | Medium — first Gemini call in this feature set |
| **10** | Personalized RAG integration | `lib/learning/context-builder.ts`, `lib/personalization/prompt-context.ts`, extend `lib/documents/rag-prompt.ts`/`rag.ts` | none | Week 2's full RAG suite re-run byte-identical with empty context; new context-budget/degradation tests | **Highest** — touches shared RAG code, mitigated by the unchanged-regression gate |
| **11** | Revision recommendations + analytics | `lib/learning/{recommendations,analytics}.ts`, `/api/learning/progress`, `/api/recommendations` | none | Ranking tests against seeded fixtures | Low |
| **12** | Frontend productization | Progress panel, Quiz UI, profile setup, End Session control | none | Manual golden-path pass per `run` workflow | Low |
| **13** | Full verification, security, documentation | README Week 3 section, full suite | none | All green — tests/lint/build — matching Week 2's frozen rigor | None |

Each phase remains independently revertible; Phase 10 is still the one place a rollback would touch shared code, and it's gated by re-running Week 2's *unmodified* test suite as a hard regression check before merging, exactly as in Revision 1.

---

## 36. Tutor MCP source audit (full classification)

Cloned and read at the source level (Go implementation + tests, not just README) under an MIT license (`Copyright (c) 2026 Arnaud Guiovanna`). **No Go code or verbatim text was copied into this design** — every formula/constant below was independently re-derived into TypeScript-shaped pseudocode from reading the source and its test-asserted behavior; the underlying algorithms themselves (BKT, IRT, PFA, FSRS, KST) originate from cited academic literature (Corbett & Anderson 1995; Lord & Novick 1968; Pavlik et al. 2009; Falmagne & Doignon 2011; the Open-Spaced-Repetition project's FSRS), which Tutor MCP itself credits and which are not anyone's proprietary expression. As academic-integrity practice (not a license requirement, since no redistribution of their code occurs), Week 3's own README will credit Tutor MCP by name and repository URL for the design patterns adapted below (individualized-BKT evidence-ramp idea, the phase-FSM/concept-selector/action-selector shape, the misconception-resolution-window heuristic, the calibration-actionability gate, the bounded-context-with-degradation pattern), alongside the same upstream academic citations Tutor MCP itself lists.

| Capability | Classification | Reasoning |
|---|---|---|
| BKT core update | **ADAPT DIRECTLY** | Small, pure, exactly matches the task's requirements; verified numerically |
| BKT clamping | **REIMPLEMENT, strengthened** | Source clamps `[0,1]` (absorbing-state risk); ours clamps `[0.02,0.98]` |
| Individualized BKT | **REIMPLEMENT CONCEPTUALLY, deferred** | Formula and ramp-weight idea documented (§7.4) but not built now — needs data volume this app won't have in v1 |
| BKT info-gain (diagnostic selection) | **SIMPLIFY** | Replaced with "least evidence first" — the audit judged the Bayesian machinery not worth it at this scale |
| PFA | **ADAPT DIRECTLY**, storage dropped | Formula/plateau-detector ported; no PFA-specific table (reuses BKT counters) |
| IRT | **ADAPT DIRECTLY, simplified iteration** | Formula/regularization ported; 8-iteration batch fit simplified to 1 Newton step per incremental response |
| FSRS | **ADAPT DIRECTLY** | Published algorithm defaults, not project-specific IP — verbatim porting is correct, not lazy |
| KST (prerequisite gating) | **ADAPT DIRECTLY** | Simple, well-tested, cheap; the one algorithm needing no simplification |
| Cycle detection (DFS) | **ADAPT DIRECTLY** | ~20-line DFS, no reason to simplify |
| Regulation pipeline (7-stage) | **SIMPLIFY, ~40% of stages dropped** | Kept: phase FSM, concept selector, action selector. Dropped/merged: goal-decomposer persistence machinery, CAS phase writes, 8-stage evidence-controller override, gate's 5-rule apparatus (merged into inline filters) |
| Fade controller | **SIMPLIFY** | 3×3 tier table with 4 outputs collapsed to 1 scaffolding tier feeding presentation only |
| Misconceptions | **REIMPLEMENT, strengthened** | Source has no real lifecycle and an unguarded LLM-authority gap; ours is a genuine improvement, not a port |
| Transfer | **SIMPLIFY** | 5 dimensions → 3; 6-state readiness ladder → 3; trust-tiering idea kept |
| Calibration | **ADAPT DIRECTLY** | Cleanest, most directly portable subsystem found |
| Metacognition/mirror | **SIMPLIFY** | 4-pattern priority list ported; Discord-delivery mechanics dropped |
| Autonomy | **ADAPT DIRECTLY** | 4-component formula ported verbatim |
| OLM (open learner model) | **REIMPLEMENT CONCEPTUALLY, deferred** | The estimated/retained/demonstrated/transferred ladder and its trusted-evaluator gate are excellent design; not built as a dedicated feature in v1 (no dashboard need for it yet) but the trust-tier concept is already reflected in §12/§32 |
| Narrative/episodic memory layering | **REIMPLEMENT CONCEPTUALLY** | Vocabulary and bounded-context pattern kept; markdown+CAS+encryption storage replaced with plain Postgres rows |
| Consolidation (LLM-driven periodic rollup) | **NOT SUITABLE for v1** | Monthly/quarterly/annual archive rollup is solving a long-lived-tenant memory-scale problem an internship-length project won't hit; the *idea* is noted for a future enhancement, not built |
| Multi-tenant/SaaS/OAuth/billing/webhooks/RBAC | **NOT SUITABLE** | Zero relevance to a single-user internship app |
| Idempotency/CAS/replay machinery | **NOT SUITABLE, simplified to constraints** | Full CAS+replay-table system replaced with unique constraints (§20) |

---

## 37. Exact Week 2 files that remain untouched — UNCHANGED from Revision 1

Same list as before — repeated here for completeness (nothing in this revision touches any of these):

```
supabase/migrations/001_document_assistant.sql   (reused conceptually as Week 3's own migration on a fresh project)
supabase/migrations/002_semantic_retrieval.sql   (same)
lib/documents/{validation,storage,pdf-extractor,chunker,embeddings,ingestion,retrieval,citations,rag-generation}.ts
lib/ai.ts, lib/prompts.ts, lib/supabase/{admin,server}.ts
app/api/{chat,documents,documents/[id],retrieval}/route.ts
components/{ChatWindow,MessageBubble,Composer,Header,EmptyState}.tsx
app/globals.css, types/{chat,documents}.ts
tests/{document-pipeline,phase2-failures,phase2-ingestion-failures,markdown-render}.test.ts
```

## Exact Week 2 files Week 3 extends — UNCHANGED set, same rationale as Revision 1

```
lib/documents/rag.ts, lib/documents/rag-prompt.ts   — one new optional dependency / one new prompt section
types/rag.ts, app/api/rag/route.ts                   — server-resolved learner context, no client-trusted fields
app/page.tsx, components/{DocumentWorkspace,ModeControls}.tsx   — additive UI only
tests/{rag-service,rag-prompt,rag-citations}.test.ts  — re-run as regression gates, new assertions added
package.json, README.md
```

---

## 38. Final consistency check (Revision 3 lock)

Every item the lock instruction asked to verify, checked directly against the sections above:

| # | Requirement | Status | Where verified |
|---|---|---|---|
| 1 | Week 2 remains untouched | PASS | §37 — zero Week 2 files modified |
| 2 | Week 3 uses its own Supabase project | PASS | §0 — fresh, independent project, locked |
| 3 | Tutor MCP remains a learner-intelligence subsystem, not the parent architecture | PASS | §3's layering diagram; §36's classification table — most capabilities SIMPLIFY/REIMPLEMENT/NOT SUITABLE, not blind adoption |
| 4 | BKT is authoritative for concept mastery | PASS | §7, §26, §32 |
| 5 | PFA does not become a redundant second mastery system | PASS | §8 — explicit statement, no new storage, reuses BKT's own counters |
| 6 | IRT ability remains separate from concept mastery | PASS | §9.1 — separate table (`learner_ability`), separate scope (student+subject, not student+concept) |
| 7 | Retention remains separate from mastery | PASS | §10 — distinct columns on the same row, never conflated; §17.1/§23 treat them as independent signals |
| 8 | Prerequisites form a lightweight DAG | PASS | §6 — two tables, DFS cycle prevention at edge-insert time only |
| 9 | Misconceptions require validated evidence | PASS | §11 — `candidate → active` requires a second independent evidence event; the LLM's proposal alone never suffices |
| 10 | Transfer is independently observable | PASS | §12 — own counters, own readiness ladder, separate trust tier |
| 11 | Calibration is based on confidence vs. actual result | PASS | §13 |
| 12 | Metacognition uses defensible signals only | PASS | §14 — four evidence-based pattern checks, no invented score |
| 13 | Scaffolding is deterministic | PASS | §15 — pure formula + fixed tier lookup |
| 14 | Gemini cannot directly modify learner state | PASS | §26, §32, §33's CAN/CANNOT list |
| 15 | Learning events remain immutable evidence | PASS | §25, §20 — append-only, no update/delete path anywhere in the design |
| 16 | Pedagogical decisions are deterministic | PASS | §17 — pure functions, zero Gemini calls |
| 17 | Personalized RAG remains ONE extension of `answerWithRag()`, not a parallel system | PASS | §21 — reaffirmed explicitly, one new optional dependency only |
| 18 | Citations/grounding/abstention remain Week 2 invariants | PASS | §21, §37 — zero lines of `lib/documents/*` core logic modified |
| 19 | Quiz answers never leak before submission | PASS | §18, §32 — unchanged server-side payload separation since Revision 1 |
| 20 | Learner-state updates are transactional and idempotent | PASS | §20 — single transaction per interaction; unique-constraint-based idempotency, not a CAS/replay subsystem |
| 21 | Tunable parameters are centralized and versionable | PASS | §6A — one `LEARNING_CONFIG` module, `version: 1`, no scattered literals, no client-exposed tuning |
| 22 | The visible learner model is evidence-backed and understandable | PASS | §30 — six-stage enum, deterministic derivation, template-based explanations, explicit evidence gates on transfer/calibration |

All 22 items pass with no exceptions found. No item required a design change beyond the numeric correction already noted in §6A/§15 (`SCAFFOLDING_TIER_BOUNDS`).

---

# ARCHITECTURE REVISION REPORT

## OLD ARCHITECTURE

**Retained:** the entire Week 2 audit (§1), the layered-thinking approach, the single-RAG-path principle (now §21, explicitly reaffirmed against new temptations), the student profile model (§4, unchanged), normalized concept-key normalization (§6, kept as the identity layer under the new graph), the bounded-context-builder *concept* (§22, now upgraded with a degradation cascade), the deterministic-ranking-not-Gemini principle for revision recommendations (§23), the "9 tables, don't inflate" discipline as a *method* (re-applied fresh in §27, arriving at 12 for a much larger scope), the auth decision (single-profile, `student_id`-ready schema — untouched), and the phased-rollout-with-regression-gates discipline (§35).

**Replaced:** the entire mastery model (weighted EMA → BKT, §7), the "no concept graph" decision (→ lightweight prerequisite graph, §6), the flat adaptive-difficulty hysteresis-only policy (→ combined BKT+IRT+PFA+hysteresis, §16), and the informal misconception mention (→ a full, stronger-than-the-source lifecycle, §11).

**Extended:** the pedagogical instinct already present in §21 (mastery-based scaffolding) into a first-class decision engine (§17) with a controlled action enum; the memory model from a flat 5-layer list into a 6-layer model with explicit corroboration rules (§5); the quiz engine's difficulty/topic selection to be pedagogical-engine-driven instead of ad hoc (§18); the DB schema from 9 to 12 tables with new tables justified individually, not by category.

## TUTOR MCP FULL-SCOPE COVERAGE

| Capability | Implementation role | Data required | Authoritative owner | Reuse strategy |
|---|---|---|---|---|
| BKT | Concept mastery estimate | `learner_concept_state.p_mastery` + per-concept/question-type `P(T)/P(S)/P(G)` | `lib/learning/bkt.ts` | ADAPT DIRECTLY (§7, §36) |
| PFA | Stagnation/plateau detector, difficulty modifier | Same counters as BKT + recent event replay | `lib/learning/pfa.ts` | ADAPT DIRECTLY, no new storage (§8) |
| IRT | Ability estimate + question-selection sanity check | `learner_ability.theta` | `lib/learning/irt.ts` | ADAPT DIRECTLY, simplified iteration (§9) |
| Retention/FSRS | Review scheduling, separate from mastery | FSRS columns on `learner_concept_state` | `lib/learning/retention.ts` | ADAPT DIRECTLY (§10) |
| Prerequisites | Readiness gate, remediation routing | `learning_concepts`/`concept_prerequisites` | `lib/learning/concepts.ts` | ADAPT DIRECTLY (§6) |
| Misconceptions | Recurring-error lifecycle | `misconceptions` | `lib/learning/misconceptions.ts` | REIMPLEMENT, strengthened (§11) |
| Transfer | Recall/application/transfer competence | Counters on `learner_concept_state` | `lib/learning/transfer.ts` | SIMPLIFY (§12) |
| Calibration | Confidence-vs-outcome tracking | `calibration_records` | `lib/learning/calibration.ts` | ADAPT DIRECTLY (§13) |
| Metacognition | Evidence-based mirror patterns | Derived from events + calibration | `lib/learning/metacognition.ts` | SIMPLIFY (§14) |
| Autonomy | Scaffolding-tier input | Derived from events + calibration | `lib/learning/autonomy.ts` | ADAPT DIRECTLY (§15) |
| Metacognition/autonomy → scaffolding | Support-level determination | Autonomy score + trend | `lib/pedagogy/select-action.ts` via `lib/learning/autonomy.ts` | ADAPT DIRECTLY, output collapsed (§15) |
| Episodic memory | Per-session record | `learning_sessions` | `lib/learning/events.ts` | REIMPLEMENT CONCEPTUALLY (§5) |
| Narrative memory | Stable cross-session observations | `narrative_memories` | `lib/learning/memory.ts` (promotion only) | REIMPLEMENT CONCEPTUALLY, strengthened trust gate (§5.1) |
| Next-activity selection | Deterministic pedagogical decision | All of the above | `lib/pedagogy/*` | SIMPLIFY, ~40% of source stages dropped (§17, §36) |

## WEEK 2 PRESERVATION

Document ingestion, embeddings, pgvector, retrieval, grounding, citations, abstention (insufficient-evidence refusal), and UI structure are **all unchanged code**, re-hosted on a fresh Supabase project per the locked infrastructure decision (§0). Zero lines of `lib/documents/*` logic are modified by this revision; the only touched files in that tree are `rag.ts`/`rag-prompt.ts`, and only additively (§21, §37).

## ARCHITECTURAL INVARIANTS

1. Exactly one RAG path — no generic/personalized fork, ever.
2. No LLM output is ever authoritative for BKT/IRT/FSRS/phase/concept/action/difficulty/misconception-status/narrative-confirmation/transfer-readiness — all are deterministic functions over stored evidence.
3. `learning_events` is immutable and append-only; every derived-state table is reproducible from it in principle.
4. Insufficient retrieval → refusal, zero generation calls, zero personalization computed — unchanged from Week 2.
5. Client-submitted correctness/scores are never trusted; the server always re-derives them.
6. Every tunable constant (thresholds, weights, clamps) is a named, documented constant in exactly one file per algorithm — never inline magic numbers duplicated across call sites.
7. Fresh Supabase project — Week 3 has no runtime dependency on Week 2's infrastructure.

## DATABASE SUMMARY

12 new tables (§27): `student_profiles`, `learning_concepts`, `concept_prerequisites`, `learner_concept_state`, `learner_ability`, `calibration_records`, `misconceptions`, `learning_events`, `learning_sessions`, `narrative_memories`, `quizzes`+`quiz_questions`+`quiz_answers` (counted as one functional group). Plus Week 2's `documents`/`document_chunks` reused on the fresh project. Explicitly rejected: `quiz_attempts`, `revision_recommendations`, a PFA table, a transfer table, an autonomy table, a pedagogical-snapshot audit table — each with its own one-line justification in §27.

## GEMINI AUTHORITY

Full CAN/CANNOT list in §33. One-sentence summary: **Gemini writes words; the learning engine writes state.**

## PHASE PLAN

14 phases (§35), Phase 0 through Phase 13, dependency-ordered exactly per the task's suggested sequence with no reordering needed — the algorithmic dependencies (concepts → BKT/PFA → IRT → retention → misconceptions/transfer/calibration → autonomy/memory → pedagogical engine → quiz → RAG → analytics → frontend → verification) already form a clean DAG.

## RISKS

- **Phase 10 (RAG integration)** remains the highest-risk phase — it's the only one touching shared, already-tested Week 2 code. Mitigated by an unmodified-regression gate, unchanged from Revision 1.
- **BKT/IRT/FSRS parameter defaults are principled but unfit-to-data** — they're literature-consistent starting points, not empirically calibrated to this app's actual question pool. Expect them to need adjustment after real usage; they're each a single named constant precisely so that's cheap.
- **Sparse per-student data** is a real, structural risk for an internship-length deployment — several safeguards (`MIN_EVIDENCE_FOR_ADAPTIVE=3`, theta's observation-count floor, calibration's 5-sample floor) exist specifically to keep the system honest ("not enough data yet") rather than confidently wrong, but the practical experience for a single student in a single semester will still be a lot of "provisional" badges early on — this is expected and correct, not a bug to engineer away.
- **Fresh Supabase project** means re-uploading test documents and re-running ingestion before any Week 3 feature can be manually verified — a real setup cost, accepted for isolation.
- **Twelve tables with cross-cutting deterministic update logic** raise real transactional-correctness stakes (§20) — the single-transaction-per-interaction discipline is the mitigation, and it's directly tested (§34's forced-failure test).

## DECISIONS RESOLVED IN THIS LOCK (Revision 3)

1. **Algorithm defaults (Decision 1)** — approved in principle, with governance, not empirical tuning. Every BKT/IRT/FSRS/PFA/calibration/hysteresis/mastery/pedagogical constant now lives in one typed, versioned module (§6A) with an explicit `MODEL_PARAMETERS` / `PRODUCT_POLICY_THRESHOLDS` / `SAFETY_CLAMPS` split and a per-value provenance tag (`PUBLISHED_ALGORITHM` / `TUTOR_MCP_CHOICE` / `OUR_CHOICE`). The BKT `[0.02, 0.98]` clamp was mathematically re-reviewed and kept as designed; 1PL/Rasch was re-reviewed and retained (nothing in the design ever consumes a discrimination parameter). No tuning surface is exposed to the client.
2. **Session staleness (Decision 2)** — locked at `STALE_SESSION_MINUTES = 90` (§31), explicitly framed as a recovery mechanism, not a precise behavioral claim. "New Chat" is confirmed to touch zero learning-evidence tables.
3. **Open Learner Model / Progress UI (Decision 3)** — locked to build (§30): a six-stage (`NEW/LEARNING/DEVELOPING/PROFICIENT/MASTERED/REVIEW_DUE`) deterministic presentation layer with template-based "why" explanations, explicit evidence gates on transfer/calibration display, and a hard rule against ever rendering raw BKT/IRT internals.

## OPEN DECISIONS

NONE.

---

## FINAL STATUS

**ARCHITECTURE STATUS: READY TO LOCK** — all prior open decisions are resolved (above), the 22-point consistency check (§38) passes with no exceptions, and no further architectural judgment calls remain that require the user's input before implementation begins.

**WEEK 2 SAFETY: PASS** — zero Week 2 files modified; zero runtime dependency on Week 2's infrastructure (fresh Supabase project); every Week 2 regression test is preserved as a gate in the phase plan (§35).

**TUTOR MCP FULL-SCOPE: PASS** — all thirteen requested capabilities (BKT, PFA, IRT, retention/FSRS, prerequisites, misconceptions, transfer, calibration, metacognition, autonomy, episodic memory, narrative memory, next-activity selection) are covered in §7–§17 and §25, each with an explicit implementation role, data requirement, authoritative owner, and Tutor MCP reuse classification, sourced from a direct read of the actual Tutor MCP Go implementation and its tests, not its README.

OPEN DECISIONS: NONE.

IMPLEMENTATION STARTED: NO.

NEXT ACTION: PHASE 0 (§35 — fresh Week 3 workspace fork + fresh Supabase project).
