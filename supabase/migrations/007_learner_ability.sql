-- Week 3 Phase 4 -- authoritative per-student/per-subject IRT ability + its own append-only
-- transition ledger (ARCHITECTURE.md §9, §20, §27).
--
-- Table name matches the locked architecture's exact §9.1/§27 SQL ("learner_ability"), not the
-- Phase 4 task's suggested "learner_subject_ability" -- Step 2 says follow the doc when names differ.
--
-- Scope: ability is per (student, subject), never per concept (§9.1) -- a completely separate
-- axis from learner_concept_state (BKT, per (student, concept)). The two tables share no columns
-- and are updated by two independent RPCs; see apply_irt_transition below and Step 13's "same
-- evidence, separate consumers" rule.

create table if not exists public.learner_ability (
  student_id uuid not null references public.student_profiles(id) on delete cascade,
  -- Normalized via lib/learning/concepts.ts::normalizeSubjectKey() before ever reaching this table
  -- -- the same identity space learning_concepts.subject and learning_sessions.subject already use.
  subject text not null check (char_length(subject) between 1 and 60),
  theta float not null default 0 check (theta between -4 and 4),
  observation_count int not null default 0 check (observation_count >= 0),
  correct_count int not null default 0 check (correct_count >= 0),
  incorrect_count int not null default 0 check (incorrect_count >= 0),
  first_observed_at timestamptz null,
  last_observed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (student_id, subject),
  -- Mirrors learner_concept_state's reconciliation invariant (Phase 4, Step 7).
  constraint learner_ability_observations_reconcile check (observation_count = correct_count + incorrect_count)
);

create trigger learner_ability_set_updated_at
before update on public.learner_ability
for each row execute procedure public.set_updated_at(); -- reuses migration 003's generic trigger fn

alter table public.learner_ability enable row level security;
-- Phase 4 is still single-user: no end-user policy is claimed here, matching every other table.

-- ---------------------------------------------------------------------------------------------
-- A DEDICATED ledger, not a repurposing of learner_state_transitions (Phase 4, Step 12). BKT's
-- ledger is shaped around mastery_before/mastery_after (a probability on the BKT scale); IRT needs
-- theta_before/theta_after (a logit-scale ability estimate) plus item_difficulty_b and
-- expected_probability, which have no BKT equivalent. Cramming both into one generically-named
-- table would blur exactly the "different scales, different meanings" separation
-- ARCHITECTURE.md §19/§27 insists BKT and IRT keep -- a dedicated table is the justified
-- choice Step 12 asks for, not the "distortion" it warns against.
-- ---------------------------------------------------------------------------------------------

create table if not exists public.learner_ability_transitions (
  id uuid primary key,
  student_id uuid not null references public.student_profiles(id) on delete cascade,
  subject text not null,
  -- Which concept's question produced this observation -- audit trail only; NOT authoritative for
  -- subject (that always comes from learning_concepts.subject at write time, Step 15).
  concept_id uuid not null references public.learning_concepts(id) on delete restrict,
  -- IRT's OWN idempotency boundary (Step 13): this UNIQUE constraint is scoped to THIS table only,
  -- so the same source_event_id can independently produce exactly one BKT transition (in
  -- learner_state_transitions) AND exactly one IRT transition (here) -- neither blocks the other,
  -- and neither table can accept the same event twice.
  source_event_id uuid not null unique references public.learning_events(id) on delete restrict,
  algorithm text not null default 'irt' check (algorithm in ('irt')),
  config_version int not null,
  item_difficulty_b float not null check (item_difficulty_b between -4 and 4),
  expected_probability float not null check (expected_probability between 0 and 1),
  outcome text not null check (outcome in ('correct', 'incorrect')),
  theta_before float not null check (theta_before between -4 and 4),
  theta_after float not null check (theta_after between -4 and 4),
  observations_before int not null check (observations_before >= 0),
  observations_after int not null check (observations_after >= 0),
  created_at timestamptz not null default now()
);

create index if not exists learner_ability_transitions_student_subject_idx
  on public.learner_ability_transitions (student_id, subject, created_at);

alter table public.learner_ability_transitions enable row level security;

-- Append-only, reusing migration 006's generic forbid_row_mutation() -- no new trigger function needed.
create trigger learner_ability_transitions_forbid_update
before update on public.learner_ability_transitions
for each row execute procedure public.forbid_row_mutation();

create trigger learner_ability_transitions_forbid_delete
before delete on public.learner_ability_transitions
for each row execute procedure public.forbid_row_mutation();
-- Break-glass maintenance path is identical to migrations 004/006's: explicitly disable one
-- trigger per statement, perform the operation, then re-enable both.

-- ---------------------------------------------------------------------------------------------
-- Atomic, idempotent, concurrency-safe ability update -- the exact same pattern as migration 006's
-- apply_bkt_transition, applied to IRT's own state/ledger pair. The Newton-step math itself lives
-- ONLY in lib/learning/irt.ts (TypeScript); this function persists an already-computed result.
-- ---------------------------------------------------------------------------------------------

create or replace function public.apply_irt_transition(
  p_transition_id uuid,
  p_student_id uuid,
  p_subject text,
  p_concept_id uuid,
  p_source_event_id uuid,
  p_item_difficulty_b float,
  p_expected_probability float,
  p_outcome text,
  p_prior_theta float,
  p_prior_observation_count int,
  p_new_theta float,
  p_config_version int
) returns table (status text, ability public.learner_ability)
language plpgsql as $$
declare
  v_ability public.learner_ability;
  v_rows_updated int;
begin
  if p_outcome not in ('correct', 'incorrect') then
    raise exception 'invalid outcome: %', p_outcome;
  end if;

  begin
    insert into public.learner_ability_transitions (
      id, student_id, subject, concept_id, source_event_id, algorithm, config_version,
      item_difficulty_b, expected_probability, outcome, theta_before, theta_after,
      observations_before, observations_after
    ) values (
      p_transition_id, p_student_id, p_subject, p_concept_id, p_source_event_id, 'irt', p_config_version,
      p_item_difficulty_b, p_expected_probability, p_outcome, p_prior_theta, p_new_theta,
      p_prior_observation_count, p_prior_observation_count + 1
    );
  exception when unique_violation then
    select * into v_ability from public.learner_ability where student_id = p_student_id and subject = p_subject;
    return query select 'already_processed'::text, v_ability;
    return;
  end;

  insert into public.learner_ability (
    student_id, subject, theta, observation_count, correct_count, incorrect_count,
    first_observed_at, last_observed_at
  ) values (
    p_student_id, p_subject, p_new_theta, 1,
    case when p_outcome = 'correct' then 1 else 0 end,
    case when p_outcome = 'incorrect' then 1 else 0 end,
    now(), now()
  )
  on conflict (student_id, subject) do update set
    theta = p_new_theta,
    observation_count = learner_ability.observation_count + 1,
    correct_count = learner_ability.correct_count + (case when p_outcome = 'correct' then 1 else 0 end),
    incorrect_count = learner_ability.incorrect_count + (case when p_outcome = 'incorrect' then 1 else 0 end),
    last_observed_at = now()
  -- CAS guard on the integer counter ONLY -- see migration 008's note on why a float (theta)
  -- comparison here is unsafe: it can spuriously fail after a JSON round-trip loses a bit of
  -- precision, even with no real concurrent writer. observation_count alone is a complete,
  -- JSON-safe version guard: it strictly increments by exactly 1 per successful update, so an
  -- unchanged count is proof nothing else touched this row since the caller's read.
  where learner_ability.observation_count = p_prior_observation_count;

  get diagnostics v_rows_updated = row_count;

  if v_rows_updated = 0 then
    -- CAS conflict, identical rationale to apply_bkt_transition: raising here rolls back the whole
    -- function, including the transition insert above.
    raise exception 'irt_cas_conflict: learner_ability changed concurrently for student % subject %', p_student_id, p_subject
      using errcode = 'P0001';
  end if;

  select * into v_ability from public.learner_ability where student_id = p_student_id and subject = p_subject;
  return query select 'applied'::text, v_ability;
end;
$$;
