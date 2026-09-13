-- Week 3 Phase 5 -- FSRS-style retention/review scheduling (ARCHITECTURE.md §10, §20, §27).
--
-- Numbering note: the architecture's own illustrative phase table (§35) suggested this migration
-- would be "008_retention_columns.sql" -- that slot was already consumed by 008_fix_cas_float_
-- equality.sql, an emergent bug-fix migration the phase table couldn't have anticipated when it was
-- written. 009 is simply the next sequential number; nothing about the retention design itself is
-- affected by which number it lands on.
--
-- Retention fields live directly on learner_concept_state (§10.1's explicit "(in
-- learner_concept_state)"), NOT a new learner_retention_state table as a task-prompt suggestion
-- implied -- resolved in favor of the architecture, the same way Phase 3/4 resolved analogous
-- naming/location conflicts (BKT's formula, IRT's table name and lib/pedagogy/difficulty.ts path).
-- Mastery (BKT) and retention (FSRS) are separate columns on the SAME row, never conflated: a
-- concept can have high p_mastery and simultaneously be due for review.

alter table public.learner_concept_state
  add column if not exists stability float null,
  add column if not exists retention_difficulty float null,
  add column if not exists card_state text not null default 'new',
  add column if not exists reps int not null default 0,
  add column if not exists lapses int not null default 0,
  add column if not exists last_reviewed_at timestamptz null,
  add column if not exists next_review_at timestamptz null;

alter table public.learner_concept_state
  add constraint learner_concept_state_card_state_check check (card_state in ('new', 'learning', 'review', 'relearning')),
  add constraint learner_concept_state_reps_check check (reps >= 0),
  add constraint learner_concept_state_lapses_check check (lapses >= 0),
  add constraint learner_concept_state_stability_check check (stability is null or stability > 0),
  -- Bounds match FSRS_DIFFICULTY_BOUNDS (lib/learning/constants.ts) -- kept in sync by convention,
  -- the same way p_mastery's CHECK above already mirrors BKT_MIN/MAX_PROBABILITY.
  add constraint learner_concept_state_retention_difficulty_check check (retention_difficulty is null or retention_difficulty between 1 and 10),
  -- stability/difficulty are always initialized together (Step 13/§10.2's initialStability+
  -- initialDifficulty pair) and never independently.
  add constraint learner_concept_state_stability_difficulty_pair check ((stability is null) = (retention_difficulty is null)),
  add constraint learner_concept_state_review_timestamps_pair check ((last_reviewed_at is null) = (next_review_at is null));

-- ---------------------------------------------------------------------------------------------
-- A DEDICATED ledger (Step 12), not a repurposing of learner_state_transitions or
-- learner_ability_transitions -- the same "different scale, different meaning" justification
-- documented in migration 007's header. Its own independent UNIQUE(source_event_id): the same
-- QUIZ_ANSWERED event that produces one BKT transition and one IRT transition also independently
-- produces exactly one FSRS transition here, and neither blocks the other (Step 11, mandatory
-- cross-model test in tests/learning-retention-integration.test.ts).
-- ---------------------------------------------------------------------------------------------

create table if not exists public.learner_retention_transitions (
  id uuid primary key,
  student_id uuid not null references public.student_profiles(id) on delete cascade,
  concept_id uuid not null references public.learning_concepts(id) on delete restrict,
  source_event_id uuid not null unique references public.learning_events(id) on delete restrict,
  algorithm text not null default 'fsrs' check (algorithm in ('fsrs')),
  config_version int not null,
  rating text not null check (rating in ('again', 'good')),
  reviewed_at timestamptz not null,
  elapsed_days float not null check (elapsed_days >= 0),
  retrievability_before float null check (retrievability_before is null or retrievability_before between 0 and 1),
  stability_before float null check (stability_before is null or stability_before > 0),
  stability_after float not null check (stability_after > 0),
  difficulty_before float null check (difficulty_before is null or difficulty_before between 1 and 10),
  difficulty_after float not null check (difficulty_after between 1 and 10),
  card_state_before text not null check (card_state_before in ('new', 'learning', 'review', 'relearning')),
  card_state_after text not null check (card_state_after in ('learning', 'review', 'relearning')),
  lapsed boolean not null,
  next_review_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists learner_retention_transitions_student_concept_idx
  on public.learner_retention_transitions (student_id, concept_id, created_at);

alter table public.learner_retention_transitions enable row level security;

-- Append-only, reusing migration 006's generic forbid_row_mutation().
create trigger learner_retention_transitions_forbid_update
before update on public.learner_retention_transitions
for each row execute procedure public.forbid_row_mutation();

create trigger learner_retention_transitions_forbid_delete
before delete on public.learner_retention_transitions
for each row execute procedure public.forbid_row_mutation();
-- Break-glass maintenance path is identical to migrations 004/006/007's.

-- ---------------------------------------------------------------------------------------------
-- Atomic, idempotent, concurrency-safe retention update. The FSRS math itself lives ONLY in
-- lib/learning/retention.ts (TypeScript) -- this function persists an already-computed result.
--
-- Concurrency safety learns directly from the Phase 4 CAS bug (migration 008): the guard below
-- compares ONLY the integer `reps` counter, never a float (stability/difficulty) or a timestamp.
-- A JSON round-trip can silently perturb a float's last bit even with zero concurrent writers,
-- which made a float-equality CAS guard spuriously fail on a second, purely sequential call in
-- Phase 4's live testing -- `reps` increments by exactly 1 per successful review and round-trips
-- through JSON exactly, so it is a complete guard on its own.
--
-- `reps` is THIS algorithm's own CAS counter, independent of BKT's `evidence_count` on the very
-- same row (§10's "separate columns, same row, never conflated"): a concurrent BKT write and a
-- concurrent FSRS write to the same learner_concept_state row serialize at the Postgres row-lock
-- level as normal, but neither's WHERE guard inspects the other's counter, so neither can spuriously
-- conflict with the other's unrelated column changes.
-- ---------------------------------------------------------------------------------------------

create or replace function public.apply_retention_transition(
  p_transition_id uuid,
  p_student_id uuid,
  p_concept_id uuid,
  p_source_event_id uuid,
  p_rating text,
  p_reviewed_at timestamptz,
  p_elapsed_days float,
  p_retrievability_before float,
  p_stability_before float,
  p_stability_after float,
  p_difficulty_before float,
  p_difficulty_after float,
  p_card_state_before text,
  p_card_state_after text,
  p_lapsed boolean,
  p_next_review_at timestamptz,
  p_prior_reps int,
  p_config_version int
) returns table (status text, state public.learner_concept_state)
language plpgsql as $$
declare
  v_state public.learner_concept_state;
  v_rows_updated int;
begin
  if p_rating not in ('again', 'good') then
    raise exception 'invalid rating: %', p_rating;
  end if;

  begin
    insert into public.learner_retention_transitions (
      id, student_id, concept_id, source_event_id, algorithm, config_version, rating, reviewed_at,
      elapsed_days, retrievability_before, stability_before, stability_after, difficulty_before,
      difficulty_after, card_state_before, card_state_after, lapsed, next_review_at
    ) values (
      p_transition_id, p_student_id, p_concept_id, p_source_event_id, 'fsrs', p_config_version, p_rating, p_reviewed_at,
      p_elapsed_days, p_retrievability_before, p_stability_before, p_stability_after, p_difficulty_before,
      p_difficulty_after, p_card_state_before, p_card_state_after, p_lapsed, p_next_review_at
    );
  exception when unique_violation then
    select * into v_state from public.learner_concept_state
      where student_id = p_student_id and concept_id = p_concept_id;
    return query select 'already_processed'::text, v_state;
    return;
  end;

  -- The insert branch's p_mastery/evidence_count placeholders mirror BKT's own global P(L0) default
  -- (lib/learning/constants.ts::BKT_DEFAULT_P_L0) purely to satisfy learner_concept_state's shared
  -- NOT NULL columns when a retention review is the very first evidence ever recorded for this
  -- (student, concept) -- FSRS never computes or asserts a mastery value. evidence_count stays 0,
  -- so if/when lib/learning/mastery.ts::applyLearningOutcome() later runs for the same or a
  -- different event, its own CAS guard (evidence_count = 0) still matches and it unconditionally
  -- overwrites this placeholder with a real, correctly-computed p_mastery.
  insert into public.learner_concept_state (
    student_id, concept_id, p_mastery, evidence_count, correct_count, incorrect_count,
    stability, retention_difficulty, card_state, reps, lapses, last_reviewed_at, next_review_at
  ) values (
    p_student_id, p_concept_id, 0.2, 0, 0, 0,
    p_stability_after, p_difficulty_after, p_card_state_after, 1,
    case when p_lapsed then 1 else 0 end, p_reviewed_at, p_next_review_at
  )
  on conflict (student_id, concept_id) do update set
    stability = p_stability_after,
    retention_difficulty = p_difficulty_after,
    card_state = p_card_state_after,
    reps = learner_concept_state.reps + 1,
    lapses = learner_concept_state.lapses + (case when p_lapsed then 1 else 0 end),
    last_reviewed_at = p_reviewed_at,
    next_review_at = p_next_review_at
  where learner_concept_state.reps = p_prior_reps; -- integer-only CAS guard, see header note

  get diagnostics v_rows_updated = row_count;

  if v_rows_updated = 0 then
    raise exception 'fsrs_cas_conflict: learner_concept_state retention fields changed concurrently for student % concept %', p_student_id, p_concept_id
      using errcode = 'P0001';
  end if;

  select * into v_state from public.learner_concept_state
    where student_id = p_student_id and concept_id = p_concept_id;
  return query select 'applied'::text, v_state;
end;
$$;
