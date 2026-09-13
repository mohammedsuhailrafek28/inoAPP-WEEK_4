// Deterministic in-memory stand-in for the Supabase admin client, scoped to exactly the query
// shapes lib/learning/{profile,sessions,events}.ts issues. Mirrors the style already established
// by tests/phase2-ingestion-failures.test.ts's fakeIngestionSupabase: a bespoke, minimal builder,
// not a general-purpose ORM mock. The two RPC functions are reimplemented here in TypeScript,
// mirroring supabase/migrations/004_learning_events.sql's plpgsql logic line-for-line, so tests can
// exercise the exact session-lifecycle atomicity rules without a live Postgres instance.

import { randomUUID } from "node:crypto";

export type Row = Record<string, unknown>;

function matchesFilters(row: Row, filters: [string, unknown][]): boolean {
  return filters.every(([column, value]) => row[column] === value);
}

interface FakeQueryResult {
  data: unknown;
  error: { code?: string; message?: string } | null;
}

interface FakeTableBuilder {
  select(): FakeTableBuilder;
  insert(payload: Row | Row[]): FakeTableBuilder;
  update(payload: Row): FakeTableBuilder;
  delete(): FakeTableBuilder;
  eq(column: string, value: unknown): FakeTableBuilder;
  order(column: string, options?: { ascending?: boolean }): FakeTableBuilder;
  limit(n: number): FakeTableBuilder;
  single(): Promise<FakeQueryResult>;
  maybeSingle(): Promise<FakeQueryResult>;
  then<T>(onFulfilled: (value: FakeQueryResult) => T, onRejected?: (error: unknown) => T): Promise<T>;
}

export function createTable(
  options: {
    uniqueKey?: (row: Row) => string | null;
    /** Emulates Postgres column DEFAULTs -- applied only to keys the insert payload omits. */
    defaults?: () => Row;
    /** Emulates an UPDATE trigger (e.g. set_updated_at) -- run after applying the update payload. */
    onUpdate?: (row: Row) => void;
  } = {},
) {
  const rows: Row[] = [];

  function builder() {
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let insertPayload: Row | Row[] | null = null;
    let updatePayload: Row | null = null;
    const filters: [string, unknown][] = [];
    const orderBy: { column: string; ascending: boolean }[] = [];
    let limitN: number | null = null;
    // Real supabase-js: `.update(...).select()` returns an array of every updated row (possibly
    // empty); with no `.select()`, `.update()` alone returns no rows at all. Every existing call
    // site immediately narrows via `.single()`/`.maybeSingle()` (which already handle an array or a
    // single object interchangeably), so this only changes behavior for a caller that awaits the
    // raw array directly -- lib/quiz/service.ts's CAS-style guarded update (Phase 9, §20), the first
    // call site in this codebase that needs to know HOW MANY rows a guarded update actually matched.
    let selectCalledAfterMutation = false;

    function currentMatches(): Row[] {
      // Tag each match with its true physical insertion index (its position in `rows`) BEFORE
      // sorting -- JS Date has only millisecond resolution, and fast, largely-synchronous test
      // execution can genuinely tie two logically-sequential rows' timestamp columns at that
      // resolution (unlike real Postgres' microsecond-resolution `now()`, which essentially never
      // does). Falling back to insertion order on a tie -- in the same direction as the requested
      // sort, so "most recent first" ties break toward whichever row was actually inserted later --
      // reproduces exactly what real Postgres timestamp precision already guarantees in production,
      // without ever altering a stored timestamp VALUE (so wall-clock-bound assertions elsewhere,
      // e.g. "this timestamp is between two Date.now() snapshots," are unaffected).
      const indexed = rows.map((row, index) => ({ row, index })).filter(({ row }) => matchesFilters(row, filters));
      let result = indexed;
      if (orderBy.length) {
        const tiebreakAscending = orderBy[0]?.ascending ?? true;
        result = [...indexed].sort((a, b) => {
          for (const { column, ascending } of orderBy) {
            const av = String(a.row[column] ?? "");
            const bv = String(b.row[column] ?? "");
            if (av === bv) continue;
            return ascending ? (av < bv ? -1 : 1) : (av > bv ? -1 : 1);
          }
          return tiebreakAscending ? a.index - b.index : b.index - a.index;
        });
      }
      let mapped = result.map(({ row }) => row);
      if (limitN != null) mapped = mapped.slice(0, limitN);
      return mapped;
    }

    function execute(): { data: unknown; error: { code?: string; message?: string } | null } {
      if (mode === "insert") {
        const toInsert = Array.isArray(insertPayload) ? insertPayload : [insertPayload as Row];
        const inserted: Row[] = [];
        for (const row of toInsert) {
          if (options.uniqueKey) {
            const key = options.uniqueKey(row);
            if (key !== null && rows.some((existing) => options.uniqueKey!(existing) === key)) {
              return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
            }
          }
          const stored = { ...(options.defaults?.() ?? {}), ...row };
          rows.push(stored);
          inserted.push(stored);
        }
        return { data: Array.isArray(insertPayload) ? inserted : inserted[0], error: null };
      }
      if (mode === "update") {
        const matches = rows.filter((row) => matchesFilters(row, filters));
        for (const row of matches) {
          Object.assign(row, updatePayload);
          options.onUpdate?.(row);
        }
        if (selectCalledAfterMutation) return { data: matches, error: null };
        return { data: matches.length ? matches[matches.length - 1] : null, error: null };
      }
      if (mode === "delete") {
        const matches = rows.filter((row) => matchesFilters(row, filters));
        for (const row of matches) {
          const index = rows.indexOf(row);
          if (index !== -1) rows.splice(index, 1);
        }
        return { data: matches, error: null };
      }
      return { data: currentMatches(), error: null };
    }

    const api: FakeTableBuilder = {
      select() {
        selectCalledAfterMutation = true;
        return api;
      },
      insert(payload: Row | Row[]) {
        mode = "insert";
        insertPayload = payload;
        return api;
      },
      update(payload: Row) {
        mode = "update";
        updatePayload = payload;
        return api;
      },
      delete() {
        mode = "delete";
        return api;
      },
      eq(column: string, value: unknown) {
        filters.push([column, value]);
        return api;
      },
      order(column: string, orderOptions?: { ascending?: boolean }) {
        orderBy.push({ column, ascending: orderOptions?.ascending ?? true });
        return api;
      },
      limit(n: number) {
        limitN = n;
        return api;
      },
      async single() {
        const { data, error } = execute();
        const array = Array.isArray(data) ? data : data ? [data] : [];
        if (!array.length) return { data: null, error: error ?? { message: "no rows returned" } };
        return { data: array[0], error };
      },
      async maybeSingle() {
        const { data, error } = execute();
        const array = Array.isArray(data) ? data : data ? [data] : [];
        return { data: array[0] ?? null, error };
      },
      then(onFulfilled, onRejected) {
        return Promise.resolve(execute()).then(onFulfilled, onRejected);
      },
    };
    return api;
  }

  return { rows, builder };
}

const VALID_END_REASONS = new Set(["explicit", "superseded", "stale_timeout"]);

/** Fully in-memory learner-foundation "database": student_profiles + learning_sessions + learning_events. */
export function createFakeLearningSupabase() {
  const profiles = createTable({
    // Mirrors supabase/migrations/003_student_profile.sql's column DEFAULTs and its
    // student_profiles_set_updated_at trigger.
    defaults: () => ({
      subjects: [],
      learning_goals: null,
      preferred_explanation_style: "simple",
      preferred_difficulty: "auto",
      preferred_pace: "standard",
      example_preference: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
    onUpdate: (row) => {
      row.updated_at = new Date().toISOString();
    },
  });
  const sessions = createTable({
    defaults: () => ({ subject: "general", status: "active", concepts_touched: [], summary: null, ended_at: null, end_reason: null }),
  });
  const events = createTable({
    uniqueKey: (row) => (row.idempotency_key != null ? `${row.student_id}::${row.idempotency_key}` : null),
    // Mirrors supabase/migrations/004_learning_events.sql's column DEFAULTs.
    defaults: () => ({
      session_id: null,
      concept_id: null,
      idempotency_key: null,
      metadata: {},
      occurred_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    }),
  });
  const concepts = createTable({
    uniqueKey: (row) => (row.concept_key != null ? String(row.concept_key) : null),
    // Mirrors supabase/migrations/005_learning_concepts.sql's column DEFAULTs and its
    // learning_concepts_set_updated_at trigger.
    defaults: () => ({
      aliases: [],
      default_p_l0: null,
      default_p_t: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
    onUpdate: (row) => {
      row.updated_at = new Date().toISOString();
    },
  });
  const prerequisites = createTable({
    uniqueKey: (row) => `${row.concept_id}::${row.prerequisite_concept_id}`,
  });
  // Shared insert-branch baseline for every RPC that can create a brand-new learner_concept_state
  // row (BKT/FSRS/transfer all can, depending on which evidence arrives first for a concept).
  // Mirrors every migration's column DEFAULTs (006/009/010) in one place -- a real bug in Phase 5
  // (fixed then, but the exact same shape of bug: a manually-constructed row literal bypassing
  // createTable's `defaults()`, which never fires for direct `.rows.push()` RPC mocks) showed this
  // needs to be centralized, not repeated per RPC, to avoid recurring silently for future phases.
  function newMasteryStateRowDefaults(): Row {
    return {
      stability: null,
      retention_difficulty: null,
      card_state: "new",
      reps: 0,
      lapses: 0,
      last_reviewed_at: null,
      next_review_at: null,
      recall_attempts: 0,
      recall_successes: 0,
      application_attempts: 0,
      application_successes: 0,
      transfer_attempts: 0,
      transfer_successes: 0,
    };
  }

  const masteryStates = createTable({
    uniqueKey: (row) => `${row.student_id}::${row.concept_id}`,
    // Mirrors supabase/migrations/006_learner_mastery.sql's, 009_retention.sql's, and
    // 010_learner_understanding.sql's column DEFAULTs, plus the table's set_updated_at trigger.
    defaults: () => ({
      evidence_count: 0,
      correct_count: 0,
      incorrect_count: 0,
      first_practiced_at: null,
      last_practiced_at: null,
      ...newMasteryStateRowDefaults(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
    onUpdate: (row) => {
      row.updated_at = new Date().toISOString();
    },
  });
  const transitions = createTable({
    uniqueKey: (row) => (row.source_event_id != null ? String(row.source_event_id) : null),
    defaults: () => ({ created_at: new Date().toISOString() }),
  });

  // Mirrors supabase/migrations/006_learner_mastery.sql::apply_bkt_transition() line-for-line,
  // including its CAS guard and its already-processed short-circuit, so tests can exercise the
  // exact atomicity/idempotency/concurrency-safety rules without a live Postgres instance.
  function applyBktTransitionRpc(params: {
    p_transition_id: string;
    p_student_id: string;
    p_concept_id: string;
    p_source_event_id: string;
    p_outcome: "correct" | "incorrect";
    p_prior_mastery: number;
    p_prior_evidence_count: number;
    p_new_mastery: number;
    p_config_version: number;
  }) {
    const existingTransition = transitions.rows.find((row) => row.source_event_id === params.p_source_event_id);
    if (existingTransition) {
      const state = masteryStates.rows.find((row) => row.student_id === params.p_student_id && row.concept_id === params.p_concept_id);
      return { data: [{ status: "already_processed", state: state ?? null }], error: null };
    }

    const now = new Date().toISOString();
    transitions.rows.push({
      id: params.p_transition_id,
      student_id: params.p_student_id,
      concept_id: params.p_concept_id,
      source_event_id: params.p_source_event_id,
      algorithm: "bkt",
      config_version: params.p_config_version,
      outcome: params.p_outcome,
      mastery_before: params.p_prior_mastery,
      mastery_after: params.p_new_mastery,
      opportunities_before: params.p_prior_evidence_count,
      opportunities_after: params.p_prior_evidence_count + 1,
      created_at: now,
    });

    const existingState = masteryStates.rows.find((row) => row.student_id === params.p_student_id && row.concept_id === params.p_concept_id);
    if (!existingState) {
      const state: Row = {
        student_id: params.p_student_id,
        concept_id: params.p_concept_id,
        p_mastery: params.p_new_mastery,
        evidence_count: 1,
        correct_count: params.p_outcome === "correct" ? 1 : 0,
        incorrect_count: params.p_outcome === "incorrect" ? 1 : 0,
        first_practiced_at: now,
        last_practiced_at: now,
        // BKT creating this row first must still leave every other subsystem's columns in exactly
        // the state their own CAS guards / "no evidence yet" reads expect, matching what real
        // Postgres column DEFAULTs give a fresh row for free (migrations 009/010).
        ...newMasteryStateRowDefaults(),
        created_at: now,
        updated_at: now,
      };
      masteryStates.rows.push(state);
      return { data: [{ status: "applied", state }], error: null };
    }

    // CAS guard: integer counter ONLY (migration 008 -- comparing the float p_mastery here was a
    // real bug, caught live in Phase 4: it can spuriously fail after a JSON round-trip loses a bit
    // of float precision even with no concurrent writer. The counter alone is a complete guard.
    if (existingState.evidence_count !== params.p_prior_evidence_count) {
      // Roll back the ledger insert above too -- the real RPC's exception aborts the whole
      // transaction, so no transition row survives a CAS conflict.
      const index = transitions.rows.findIndex((row) => row.id === params.p_transition_id);
      if (index !== -1) transitions.rows.splice(index, 1);
      return { data: null, error: { message: `bkt_cas_conflict: learner_concept_state changed concurrently for student ${params.p_student_id} concept ${params.p_concept_id}` } };
    }

    existingState.p_mastery = params.p_new_mastery;
    existingState.evidence_count = (existingState.evidence_count as number) + 1;
    if (params.p_outcome === "correct") existingState.correct_count = (existingState.correct_count as number) + 1;
    else existingState.incorrect_count = (existingState.incorrect_count as number) + 1;
    existingState.last_practiced_at = now;
    existingState.updated_at = now;
    return { data: [{ status: "applied", state: existingState }], error: null };
  }

  // Phase 9 additions (migration 012) -- §17.1's phase FSM + §17.2's anti-repeat pointer. Factored
  // out (mirrors newMasteryStateRowDefaults() above) so applyIrtTransitionRpc()'s own manually-
  // constructed insert literal below can spread it too, never bypassing these defaults the way the
  // Phase 5 bug this pattern fixed once did.
  function abilityPhaseColumnDefaults(): Row {
    return { phase: "DIAGNOSTIC", phase_changed_at: null, last_selected_concept_id: null, last_selected_at: null };
  }

  const abilities = createTable({
    uniqueKey: (row) => `${row.student_id}::${row.subject}`,
    defaults: () => ({
      theta: 0,
      observation_count: 0,
      correct_count: 0,
      incorrect_count: 0,
      first_observed_at: null,
      last_observed_at: null,
      ...abilityPhaseColumnDefaults(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
    onUpdate: (row) => {
      row.updated_at = new Date().toISOString();
    },
  });
  const abilityTransitions = createTable({
    uniqueKey: (row) => (row.source_event_id != null ? String(row.source_event_id) : null),
    defaults: () => ({ created_at: new Date().toISOString() }),
  });

  // Mirrors supabase/migrations/007_learner_ability.sql::apply_irt_transition() line-for-line --
  // the same CAS/idempotency shape as applyBktTransitionRpc, on IRT's own dedicated state+ledger
  // pair (Step 13: IRT's UNIQUE(source_event_id) boundary is independent of BKT's).
  function applyIrtTransitionRpc(params: {
    p_transition_id: string;
    p_student_id: string;
    p_subject: string;
    p_concept_id: string;
    p_source_event_id: string;
    p_item_difficulty_b: number;
    p_expected_probability: number;
    p_outcome: "correct" | "incorrect";
    p_prior_theta: number;
    p_prior_observation_count: number;
    p_new_theta: number;
    p_config_version: number;
  }) {
    const existingTransition = abilityTransitions.rows.find((row) => row.source_event_id === params.p_source_event_id);
    if (existingTransition) {
      const ability = abilities.rows.find((row) => row.student_id === params.p_student_id && row.subject === params.p_subject);
      return { data: [{ status: "already_processed", ability: ability ?? null }], error: null };
    }

    const now = new Date().toISOString();
    abilityTransitions.rows.push({
      id: params.p_transition_id,
      student_id: params.p_student_id,
      subject: params.p_subject,
      concept_id: params.p_concept_id,
      source_event_id: params.p_source_event_id,
      algorithm: "irt",
      config_version: params.p_config_version,
      item_difficulty_b: params.p_item_difficulty_b,
      expected_probability: params.p_expected_probability,
      outcome: params.p_outcome,
      theta_before: params.p_prior_theta,
      theta_after: params.p_new_theta,
      observations_before: params.p_prior_observation_count,
      observations_after: params.p_prior_observation_count + 1,
      created_at: now,
    });

    const existingAbility = abilities.rows.find((row) => row.student_id === params.p_student_id && row.subject === params.p_subject);
    if (!existingAbility) {
      // Spread the table's own defaults() first (Phase 9's phase/last_selected_* columns included)
      // -- see newMasteryStateRowDefaults()'s own comment for why a manually-constructed insert
      // literal must never bypass createTable()'s defaults factory (the Phase 5 bug this pattern
      // fixed permanently).
      const ability: Row = {
        ...abilityPhaseColumnDefaults(),
        student_id: params.p_student_id,
        subject: params.p_subject,
        theta: params.p_new_theta,
        observation_count: 1,
        correct_count: params.p_outcome === "correct" ? 1 : 0,
        incorrect_count: params.p_outcome === "incorrect" ? 1 : 0,
        first_observed_at: now,
        last_observed_at: now,
        created_at: now,
        updated_at: now,
      };
      abilities.rows.push(ability);
      return { data: [{ status: "applied", ability }], error: null };
    }

    // CAS guard: integer counter ONLY -- see the matching note above (migration 008).
    if (existingAbility.observation_count !== params.p_prior_observation_count) {
      const index = abilityTransitions.rows.findIndex((row) => row.id === params.p_transition_id);
      if (index !== -1) abilityTransitions.rows.splice(index, 1);
      return { data: null, error: { message: `irt_cas_conflict: learner_ability changed concurrently for student ${params.p_student_id} subject ${params.p_subject}` } };
    }

    existingAbility.theta = params.p_new_theta;
    existingAbility.observation_count = (existingAbility.observation_count as number) + 1;
    if (params.p_outcome === "correct") existingAbility.correct_count = (existingAbility.correct_count as number) + 1;
    else existingAbility.incorrect_count = (existingAbility.incorrect_count as number) + 1;
    existingAbility.last_observed_at = now;
    existingAbility.updated_at = now;
    return { data: [{ status: "applied", ability: existingAbility }], error: null };
  }

  const retentionTransitions = createTable({
    uniqueKey: (row) => (row.source_event_id != null ? String(row.source_event_id) : null),
    defaults: () => ({ created_at: new Date().toISOString() }),
  });

  // Mirrors supabase/migrations/009_retention.sql::apply_retention_transition() line-for-line --
  // the same CAS/idempotency shape as the BKT/IRT RPCs above, on FSRS's own dedicated ledger, with
  // the integer `reps` counter as its CAS guard (never a float/timestamp, per the Phase 4 CAS bug's
  // lesson -- migration 008's own note applies here from the start).
  function applyRetentionTransitionRpc(params: {
    p_transition_id: string;
    p_student_id: string;
    p_concept_id: string;
    p_source_event_id: string;
    p_rating: "again" | "good";
    p_reviewed_at: string;
    p_elapsed_days: number;
    p_retrievability_before: number | null;
    p_stability_before: number | null;
    p_stability_after: number;
    p_difficulty_before: number | null;
    p_difficulty_after: number;
    p_card_state_before: string;
    p_card_state_after: string;
    p_lapsed: boolean;
    p_next_review_at: string;
    p_prior_reps: number;
    p_config_version: number;
  }) {
    const existingTransition = retentionTransitions.rows.find((row) => row.source_event_id === params.p_source_event_id);
    if (existingTransition) {
      const state = masteryStates.rows.find((row) => row.student_id === params.p_student_id && row.concept_id === params.p_concept_id);
      return { data: [{ status: "already_processed", state: state ?? null }], error: null };
    }

    const now = new Date().toISOString();
    retentionTransitions.rows.push({
      id: params.p_transition_id,
      student_id: params.p_student_id,
      concept_id: params.p_concept_id,
      source_event_id: params.p_source_event_id,
      algorithm: "fsrs",
      config_version: params.p_config_version,
      rating: params.p_rating,
      reviewed_at: params.p_reviewed_at,
      elapsed_days: params.p_elapsed_days,
      retrievability_before: params.p_retrievability_before,
      stability_before: params.p_stability_before,
      stability_after: params.p_stability_after,
      difficulty_before: params.p_difficulty_before,
      difficulty_after: params.p_difficulty_after,
      card_state_before: params.p_card_state_before,
      card_state_after: params.p_card_state_after,
      lapsed: params.p_lapsed,
      next_review_at: params.p_next_review_at,
      created_at: now,
    });

    const existingState = masteryStates.rows.find((row) => row.student_id === params.p_student_id && row.concept_id === params.p_concept_id);
    if (!existingState) {
      // Mirrors the real RPC's insert-branch placeholder: p_mastery/evidence_count default values
      // satisfy learner_concept_state's shared NOT NULL columns when retention is the first-ever
      // evidence for this (student, concept) -- overwritten unconditionally the moment BKT runs.
      const state: Row = {
        student_id: params.p_student_id,
        concept_id: params.p_concept_id,
        p_mastery: 0.2,
        evidence_count: 0,
        correct_count: 0,
        incorrect_count: 0,
        first_practiced_at: null,
        last_practiced_at: null,
        ...newMasteryStateRowDefaults(),
        stability: params.p_stability_after,
        retention_difficulty: params.p_difficulty_after,
        card_state: params.p_card_state_after,
        reps: 1,
        lapses: params.p_lapsed ? 1 : 0,
        last_reviewed_at: params.p_reviewed_at,
        next_review_at: params.p_next_review_at,
        created_at: now,
        updated_at: now,
      };
      masteryStates.rows.push(state);
      return { data: [{ status: "applied", state }], error: null };
    }

    if ((existingState.reps as number) !== params.p_prior_reps) {
      const index = retentionTransitions.rows.findIndex((row) => row.id === params.p_transition_id);
      if (index !== -1) retentionTransitions.rows.splice(index, 1);
      return { data: null, error: { message: `fsrs_cas_conflict: learner_concept_state retention fields changed concurrently for student ${params.p_student_id} concept ${params.p_concept_id}` } };
    }

    existingState.stability = params.p_stability_after;
    existingState.retention_difficulty = params.p_difficulty_after;
    existingState.card_state = params.p_card_state_after;
    existingState.reps = (existingState.reps as number) + 1;
    existingState.lapses = (existingState.lapses as number) + (params.p_lapsed ? 1 : 0);
    existingState.last_reviewed_at = params.p_reviewed_at;
    existingState.next_review_at = params.p_next_review_at;
    existingState.updated_at = now;
    return { data: [{ status: "applied", state: existingState }], error: null };
  }

  const misconceptions = createTable({
    uniqueKey: (row) => `${row.student_id}::${row.concept_id}::${row.tag}`,
    defaults: () => ({ created_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
    onUpdate: (row) => {
      row.updated_at = new Date().toISOString();
    },
  });
  const misconceptionEvidence = createTable({
    uniqueKey: (row) => (row.source_event_id != null ? String(row.source_event_id) : null),
    defaults: () => ({ created_at: new Date().toISOString() }),
  });

  // Mirrors supabase/migrations/010_learner_understanding.sql::apply_misconception_evidence() --
  // the activation/reactivation DECISION was already made in TypeScript; this mock, like the real
  // RPC, only persists it, guarded by the integer evidence_count CAS.
  function applyMisconceptionEvidenceRpc(params: {
    p_transition_id: string;
    p_student_id: string;
    p_concept_id: string;
    p_source_event_id: string;
    p_tag: string;
    p_description: string;
    p_prior_evidence_count: number;
    p_new_evidence_count: number;
    p_prior_status: string | null;
    p_new_status: string;
    p_config_version: number;
  }) {
    const existingEvidence = misconceptionEvidence.rows.find((row) => row.source_event_id === params.p_source_event_id);
    if (existingEvidence) {
      const misconception = misconceptions.rows.find((row) => row.student_id === params.p_student_id && row.concept_id === params.p_concept_id && row.tag === existingEvidence.tag);
      return { data: [{ status: "already_processed", misconception: misconception ?? null }], error: null };
    }

    const now = new Date().toISOString();
    misconceptionEvidence.rows.push({
      id: params.p_transition_id,
      student_id: params.p_student_id,
      concept_id: params.p_concept_id,
      tag: params.p_tag,
      source_event_id: params.p_source_event_id,
      algorithm: "misconception",
      config_version: params.p_config_version,
      description: params.p_description,
      status_before: params.p_prior_status,
      status_after: params.p_new_status,
      evidence_count_before: params.p_prior_evidence_count,
      evidence_count_after: params.p_new_evidence_count,
      created_at: now,
    });

    const existingMisconception = misconceptions.rows.find((row) => row.student_id === params.p_student_id && row.concept_id === params.p_concept_id && row.tag === params.p_tag);
    if (!existingMisconception) {
      const misconception: Row = {
        id: randomUUID(),
        student_id: params.p_student_id,
        concept_id: params.p_concept_id,
        tag: params.p_tag,
        description: params.p_description,
        status: params.p_new_status,
        evidence_count: params.p_new_evidence_count,
        first_seen_at: now,
        last_seen_at: now,
        created_at: now,
        updated_at: now,
      };
      misconceptions.rows.push(misconception);
      return { data: [{ status: "applied", misconception }], error: null };
    }

    if ((existingMisconception.evidence_count as number) !== params.p_prior_evidence_count) {
      const index = misconceptionEvidence.rows.findIndex((row) => row.id === params.p_transition_id);
      if (index !== -1) misconceptionEvidence.rows.splice(index, 1);
      return { data: null, error: { message: `misconception_cas_conflict: misconceptions changed concurrently for student ${params.p_student_id} concept ${params.p_concept_id} tag ${params.p_tag}` } };
    }

    existingMisconception.description = params.p_description;
    existingMisconception.status = params.p_new_status;
    existingMisconception.evidence_count = params.p_new_evidence_count;
    existingMisconception.last_seen_at = now;
    existingMisconception.updated_at = now;
    return { data: [{ status: "applied", misconception: existingMisconception }], error: null };
  }

  const transferEvidence = createTable({
    uniqueKey: (row) => (row.source_event_id != null ? String(row.source_event_id) : null),
    defaults: () => ({ created_at: new Date().toISOString() }),
  });

  // Mirrors supabase/migrations/010_learner_understanding.sql::apply_transfer_evidence(). CAS
  // guard: the sum of all three *_attempts columns, an integer that strictly increases by 1 per
  // applied evidence row regardless of which level it targets -- never a float/timestamp.
  function applyTransferEvidenceRpc(params: {
    p_transition_id: string;
    p_student_id: string;
    p_concept_id: string;
    p_source_event_id: string;
    p_level: "recall" | "application" | "transfer";
    p_score: number;
    p_success: boolean;
    p_evidence_trust: "deterministic" | "llm_graded";
    p_prior_total_attempts: number;
    p_config_version: number;
  }) {
    const existingEvidence = transferEvidence.rows.find((row) => row.source_event_id === params.p_source_event_id);
    if (existingEvidence) {
      const state = masteryStates.rows.find((row) => row.student_id === params.p_student_id && row.concept_id === params.p_concept_id);
      return { data: [{ status: "already_processed", state: state ?? null }], error: null };
    }

    const now = new Date().toISOString();
    transferEvidence.rows.push({
      id: params.p_transition_id,
      student_id: params.p_student_id,
      concept_id: params.p_concept_id,
      source_event_id: params.p_source_event_id,
      algorithm: "transfer",
      config_version: params.p_config_version,
      level: params.p_level,
      score: params.p_score,
      success: params.p_success,
      evidence_trust: params.p_evidence_trust,
      created_at: now,
    });

    const levelAttemptsCol = `${params.p_level}_attempts` as const;
    const levelSuccessesCol = `${params.p_level}_successes` as const;

    const existingState = masteryStates.rows.find((row) => row.student_id === params.p_student_id && row.concept_id === params.p_concept_id);
    if (!existingState) {
      const state: Row = {
        student_id: params.p_student_id,
        concept_id: params.p_concept_id,
        p_mastery: 0.2,
        evidence_count: 0,
        correct_count: 0,
        incorrect_count: 0,
        first_practiced_at: null,
        last_practiced_at: null,
        ...newMasteryStateRowDefaults(),
        [levelAttemptsCol]: 1,
        [levelSuccessesCol]: params.p_success ? 1 : 0,
        created_at: now,
        updated_at: now,
      };
      masteryStates.rows.push(state);
      return { data: [{ status: "applied", state }], error: null };
    }

    const totalAttempts = (existingState.recall_attempts as number) + (existingState.application_attempts as number) + (existingState.transfer_attempts as number);
    if (totalAttempts !== params.p_prior_total_attempts) {
      const index = transferEvidence.rows.findIndex((row) => row.id === params.p_transition_id);
      if (index !== -1) transferEvidence.rows.splice(index, 1);
      return { data: null, error: { message: `transfer_cas_conflict: learner_concept_state transfer counters changed concurrently for student ${params.p_student_id} concept ${params.p_concept_id}` } };
    }

    existingState[levelAttemptsCol] = (existingState[levelAttemptsCol] as number) + 1;
    if (params.p_success) existingState[levelSuccessesCol] = (existingState[levelSuccessesCol] as number) + 1;
    existingState.updated_at = now;
    return { data: [{ status: "applied", state: existingState }], error: null };
  }

  const calibrationRecords = createTable({
    // Partial-unique emulation (mirrors the real partial unique index `WHERE actual IS NULL`):
    // only an OPEN record's key participates in the uniqueness check -- a resolved record returns
    // null and never collides with anything.
    uniqueKey: (row) => (row.actual == null ? `${row.student_id}::${row.concept_id}::open` : null),
    defaults: () => ({ actual: null, delta: null, source_event_id: null, created_at: new Date().toISOString(), resolved_at: null }),
  });

  // Mirrors supabase/migrations/011_learning_memory.sql -- a plain mutable table (pending ->
  // confirmed is a real, single, deterministic transition, §5.1), no dedicated RPC needed: the
  // generic insert/update/delete query-builder chain is sufficient for lib/learning/memory.ts's needs.
  const narrativeMemories = createTable({
    defaults: () => ({ status: "pending", corroborated_by: null, created_at: new Date().toISOString() }),
  });

  // Mirrors supabase/migrations/010_learner_understanding.sql::resolve_calibration_prediction().
  // Not a CAS-retry situation (see the real RPC's own comment) -- a genuine "no open prediction" is
  // a hard error, and a retried sourceEventId is idempotent via a direct lookup, not a counter.
  function resolveCalibrationPredictionRpc(params: { p_student_id: string; p_concept_id: string; p_source_event_id: string; p_actual: number; p_delta: number }) {
    const existing = calibrationRecords.rows.find((row) => row.source_event_id === params.p_source_event_id);
    if (existing) return { data: [{ status: "already_processed", record: existing }], error: null };

    const openRecord = calibrationRecords.rows.find((row) => row.student_id === params.p_student_id && row.concept_id === params.p_concept_id && row.actual == null);
    if (!openRecord) {
      return { data: null, error: { message: `calibration_no_open_prediction: no open calibration prediction for student ${params.p_student_id} concept ${params.p_concept_id}` } };
    }

    openRecord.actual = params.p_actual;
    openRecord.delta = params.p_delta;
    openRecord.source_event_id = params.p_source_event_id;
    openRecord.resolved_at = new Date().toISOString();
    return { data: [{ status: "applied", record: openRecord }], error: null };
  }

  function startLearningSessionRpc(params: {
    p_student_id: string;
    p_subject: string | null;
    p_session_id: string;
    p_event_id: string;
    p_idempotency_key?: string | null;
  }) {
    const idempotencyKey = params.p_idempotency_key ?? null;
    if (idempotencyKey) {
      const existingEvent = events.rows.find(
        (row) => row.student_id === params.p_student_id && row.idempotency_key === idempotencyKey && row.event_type === "SESSION_STARTED",
      );
      if (existingEvent) {
        const existingSession = sessions.rows.find((row) => row.id === existingEvent.session_id);
        return { data: existingSession ?? null, error: existingSession ? null : { message: "session not found" } };
      }
    }

    for (const row of sessions.rows) {
      if (row.student_id === params.p_student_id && row.status === "active") {
        row.status = "ended";
        row.ended_at = new Date().toISOString();
        row.end_reason = "superseded";
      }
    }

    const now = new Date().toISOString();
    const session: Row = {
      id: params.p_session_id,
      student_id: params.p_student_id,
      subject: params.p_subject ?? "general",
      status: "active",
      started_at: now,
      last_active_at: now,
      ended_at: null,
      end_reason: null,
      concepts_touched: [],
      summary: null,
    };
    sessions.rows.push(session);
    events.rows.push({
      id: params.p_event_id,
      student_id: params.p_student_id,
      session_id: session.id,
      event_type: "SESSION_STARTED",
      concept_id: null,
      idempotency_key: idempotencyKey,
      metadata: { subject: session.subject },
      occurred_at: now,
      created_at: now,
    });
    return { data: session, error: null };
  }

  function endLearningSessionRpc(params: {
    p_session_id: string;
    p_student_id: string;
    p_end_reason: string;
    p_event_id: string;
    p_idempotency_key?: string | null;
  }) {
    if (!VALID_END_REASONS.has(params.p_end_reason)) {
      return { data: null, error: { message: `invalid end_reason: ${params.p_end_reason}` } };
    }
    const idempotencyKey = params.p_idempotency_key ?? null;
    if (idempotencyKey) {
      const alreadyEnded = events.rows.some(
        (row) => row.student_id === params.p_student_id && row.idempotency_key === idempotencyKey && row.event_type === "SESSION_ENDED",
      );
      if (alreadyEnded) {
        const session = sessions.rows.find((row) => row.id === params.p_session_id);
        return { data: session ?? null, error: null };
      }
    }

    const session = sessions.rows.find((row) => row.id === params.p_session_id && row.student_id === params.p_student_id);
    if (!session || session.status !== "active") {
      const current = sessions.rows.find((row) => row.id === params.p_session_id && row.student_id === params.p_student_id);
      return { data: current ?? null, error: null };
    }

    const now = new Date().toISOString();
    session.status = "ended";
    session.ended_at = now;
    session.end_reason = params.p_end_reason;
    events.rows.push({
      id: params.p_event_id,
      student_id: params.p_student_id,
      session_id: session.id,
      event_type: "SESSION_ENDED",
      concept_id: null,
      idempotency_key: idempotencyKey,
      metadata: { end_reason: params.p_end_reason },
      occurred_at: now,
      created_at: now,
    });
    return { data: session, error: null };
  }

  // Mirrors supabase/migrations/012_adaptive_quiz.sql. No dedicated RPCs -- lib/quiz/service.ts's
  // idempotency mechanism is a plain WHERE-guarded update (§20), not a CAS-retry RPC, so the
  // generic insert/update/select query-builder chain is sufficient, exactly like
  // narrative_memories/calibration_records above.
  const quizzes = createTable({
    defaults: () => ({ session_id: null, status: "in_progress", score: null, created_at: new Date().toISOString(), submitted_at: null }),
  });
  const quizQuestions = createTable({
    defaults: () => ({ options: null, citations: [], created_at: new Date().toISOString() }),
  });
  const quizAnswers = createTable({
    uniqueKey: (row) => `${row.quiz_id}::${row.question_id}`,
    defaults: () => ({ feedback: null, response_time_ms: null, created_at: new Date().toISOString() }),
  });

  // Mirrors supabase/migrations/013_agent_activity.sql. No RPC -- a plain insert/select table like
  // quizzes/quiz_questions above; append-only is enforced by a real-Postgres trigger this fake DB
  // does not reimplement (lib/learning/agent-activity.ts itself exposes no update/delete path at
  // all, which is what tests/agent-activity.test.ts actually verifies).
  const agentActivity = createTable({
    defaults: () => ({ concept_id: null, concept_key: null, reason_codes: [], metadata: {}, created_at: new Date().toISOString() }),
  });

  return {
    tables: {
      profiles,
      sessions,
      events,
      concepts,
      prerequisites,
      masteryStates,
      transitions,
      abilities,
      abilityTransitions,
      retentionTransitions,
      misconceptions,
      misconceptionEvidence,
      transferEvidence,
      calibrationRecords,
      narrativeMemories,
      quizzes,
      quizQuestions,
      quizAnswers,
      agentActivity,
    },
    from(
      table:
        | "student_profiles"
        | "learning_sessions"
        | "learning_events"
        | "learning_concepts"
        | "concept_prerequisites"
        | "learner_concept_state"
        | "learner_state_transitions"
        | "learner_ability"
        | "learner_ability_transitions"
        | "learner_retention_transitions"
        | "misconceptions"
        | "misconception_evidence"
        | "transfer_evidence"
        | "calibration_records"
        | "narrative_memories"
        | "quizzes"
        | "quiz_questions"
        | "quiz_answers"
        | "agent_activity_log",
    ) {
      if (table === "student_profiles") return profiles.builder();
      if (table === "learning_sessions") return sessions.builder();
      if (table === "learning_concepts") return concepts.builder();
      if (table === "concept_prerequisites") return prerequisites.builder();
      if (table === "narrative_memories") return narrativeMemories.builder();
      if (table === "learner_concept_state") return masteryStates.builder();
      if (table === "learner_state_transitions") return transitions.builder();
      if (table === "learner_ability") return abilities.builder();
      if (table === "learner_ability_transitions") return abilityTransitions.builder();
      if (table === "learner_retention_transitions") return retentionTransitions.builder();
      if (table === "misconceptions") return misconceptions.builder();
      if (table === "misconception_evidence") return misconceptionEvidence.builder();
      if (table === "transfer_evidence") return transferEvidence.builder();
      if (table === "calibration_records") return calibrationRecords.builder();
      if (table === "quizzes") return quizzes.builder();
      if (table === "quiz_questions") return quizQuestions.builder();
      if (table === "quiz_answers") return quizAnswers.builder();
      if (table === "agent_activity_log") return agentActivity.builder();
      return events.builder();
    },
    async rpc(
      fn:
        | "start_learning_session"
        | "end_learning_session"
        | "apply_bkt_transition"
        | "apply_irt_transition"
        | "apply_retention_transition"
        | "apply_misconception_evidence"
        | "apply_transfer_evidence"
        | "resolve_calibration_prediction",
      params: Record<string, unknown>,
    ) {
      if (fn === "start_learning_session") return startLearningSessionRpc(params as Parameters<typeof startLearningSessionRpc>[0]);
      if (fn === "end_learning_session") return endLearningSessionRpc(params as Parameters<typeof endLearningSessionRpc>[0]);
      if (fn === "apply_bkt_transition") return applyBktTransitionRpc(params as Parameters<typeof applyBktTransitionRpc>[0]);
      if (fn === "apply_irt_transition") return applyIrtTransitionRpc(params as Parameters<typeof applyIrtTransitionRpc>[0]);
      if (fn === "apply_retention_transition") return applyRetentionTransitionRpc(params as Parameters<typeof applyRetentionTransitionRpc>[0]);
      if (fn === "apply_misconception_evidence") return applyMisconceptionEvidenceRpc(params as Parameters<typeof applyMisconceptionEvidenceRpc>[0]);
      if (fn === "apply_transfer_evidence") return applyTransferEvidenceRpc(params as Parameters<typeof applyTransferEvidenceRpc>[0]);
      return resolveCalibrationPredictionRpc(params as Parameters<typeof resolveCalibrationPredictionRpc>[0]);
    },
  };
}

export type FakeLearningSupabase = ReturnType<typeof createFakeLearningSupabase>;
