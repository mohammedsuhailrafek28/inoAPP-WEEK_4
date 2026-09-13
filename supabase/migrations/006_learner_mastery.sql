-- Week 3 Phase 3 -- authoritative per-student/per-concept BKT mastery state + its append-only
-- transition ledger (ARCHITECTURE.md §7, §20, §27).
--
-- Deliberately NOT here yet (Step 6): any IRT (theta), FSRS (stability/retention_difficulty/
-- next_review_at/card_state), transfer, or misconception column. §27's full learner_concept_state
-- sketch reserves those for their own phases (4/5/6) via ALTER TABLE, exactly like Phase 2 added
-- learning_events.concept_id onto an already-shipped table. Only the BKT-relevant columns land now.

create table if not exists public.learner_concept_state (
  student_id uuid not null references public.student_profiles(id) on delete cascade,
  concept_id uuid not null references public.learning_concepts(id) on delete restrict,
  p_mastery float not null check (p_mastery between 0.02 and 0.98),
  evidence_count int not null default 0 check (evidence_count >= 0),
  correct_count int not null default 0 check (correct_count >= 0),
  incorrect_count int not null default 0 check (incorrect_count >= 0),
  first_practiced_at timestamptz null,
  last_practiced_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (student_id, concept_id),
  -- "successes + failures == opportunities for scored outcomes" (Phase 3, Step 6/25) -- enforced
  -- at the database level, not just by application discipline.
  constraint learner_concept_state_evidence_reconciles check (evidence_count = correct_count + incorrect_count)
);

create index if not exists learner_concept_state_concept_idx on public.learner_concept_state (concept_id);

create trigger learner_concept_state_set_updated_at
before update on public.learner_concept_state
for each row execute procedure public.set_updated_at(); -- reuses migration 003's generic trigger fn

alter table public.learner_concept_state enable row level security;
-- Phase 3 is still single-user: no end-user policy is claimed here, matching every other table.

-- ---------------------------------------------------------------------------------------------
-- Immutable, append-only audit/replay ledger (Step 11/12). Authoritative CURRENT state lives in
-- learner_concept_state; authoritative RAW evidence lives in learning_events; this table is proof
-- of what happened between the two -- never a second source of truth for "what is mastery now."
-- ---------------------------------------------------------------------------------------------

create table if not exists public.learner_state_transitions (
  id uuid primary key,
  student_id uuid not null references public.student_profiles(id) on delete cascade,
  concept_id uuid not null references public.learning_concepts(id) on delete restrict,
  -- The actual "same evidence cannot update mastery twice" mechanism (Step 8/11): a UNIQUE
  -- constraint, enforced by Postgres even under concurrent submission, not an application-level
  -- check that a race condition could slip past.
  source_event_id uuid not null unique references public.learning_events(id) on delete restrict,
  algorithm text not null default 'bkt' check (algorithm in ('bkt')),
  config_version int not null,
  outcome text not null check (outcome in ('correct', 'incorrect')),
  mastery_before float not null check (mastery_before between 0.02 and 0.98),
  mastery_after float not null check (mastery_after between 0.02 and 0.98),
  opportunities_before int not null check (opportunities_before >= 0),
  opportunities_after int not null check (opportunities_after >= 0),
  created_at timestamptz not null default now()
);

create index if not exists learner_state_transitions_student_concept_idx
  on public.learner_state_transitions (student_id, concept_id, created_at);

alter table public.learner_state_transitions enable row level security;

-- Generic append-only guard (a fresh function, not a reuse-by-edit of migration 004's
-- forbid_learning_event_mutation() -- that migration is already applied and untouched; TG_TABLE_NAME
-- makes this version reusable by any future append-only table without a hardcoded message).
create or replace function public.forbid_row_mutation()
returns trigger language plpgsql as $$
begin
  raise exception '% is append-only: % is not permitted', tg_table_name, tg_op;
end;
$$;

create trigger learner_state_transitions_forbid_update
before update on public.learner_state_transitions
for each row execute procedure public.forbid_row_mutation();

create trigger learner_state_transitions_forbid_delete
before delete on public.learner_state_transitions
for each row execute procedure public.forbid_row_mutation();
-- Break-glass maintenance path is identical to migration 004's: explicitly
-- `alter table public.learner_state_transitions disable trigger <name>` (one statement per
-- trigger), perform the operation, then re-enable both -- never a silent runtime bypass.

-- ---------------------------------------------------------------------------------------------
-- Atomic, idempotent, concurrency-safe state update (Step 10/19). The BKT math itself lives ONLY
-- in lib/learning/bkt.ts (TypeScript) -- this function persists an already-computed result, it
-- does not recompute the formula in SQL. Concurrency safety comes from two independent guards:
--   1. source_event_id UNIQUE on learner_state_transitions -- a duplicate/retried event is caught
--      here and reported as already-processed, never double-applied.
--   2. An optimistic-concurrency (CAS) guard on the learner_concept_state UPSERT -- if the row's
--      p_mastery/evidence_count no longer match what the caller read before computing, the UPDATE
--      branch matches zero rows and the whole function raises, rolling back the transition insert
--      too (atomicity: state and ledger succeed or fail together). The caller (lib/learning/
--      mastery.ts) re-reads and retries on that specific error.
-- ---------------------------------------------------------------------------------------------

create or replace function public.apply_bkt_transition(
  p_transition_id uuid,
  p_student_id uuid,
  p_concept_id uuid,
  p_source_event_id uuid,
  p_outcome text,
  p_prior_mastery float,
  p_prior_evidence_count int,
  p_new_mastery float,
  p_config_version int
) returns table (status text, state public.learner_concept_state)
language plpgsql as $$
declare
  v_state public.learner_concept_state;
  v_rows_updated int;
begin
  if p_outcome not in ('correct', 'incorrect') then
    raise exception 'invalid outcome: %', p_outcome;
  end if;

  begin
    insert into public.learner_state_transitions (
      id, student_id, concept_id, source_event_id, algorithm, config_version, outcome,
      mastery_before, mastery_after, opportunities_before, opportunities_after
    ) values (
      p_transition_id, p_student_id, p_concept_id, p_source_event_id, 'bkt', p_config_version, p_outcome,
      p_prior_mastery, p_new_mastery, p_prior_evidence_count, p_prior_evidence_count + 1
    );
  exception when unique_violation then
    select * into v_state from public.learner_concept_state
      where student_id = p_student_id and concept_id = p_concept_id;
    return query select 'already_processed'::text, v_state;
    return;
  end;

  insert into public.learner_concept_state (
    student_id, concept_id, p_mastery, evidence_count, correct_count, incorrect_count,
    first_practiced_at, last_practiced_at
  ) values (
    p_student_id, p_concept_id, p_new_mastery, 1,
    case when p_outcome = 'correct' then 1 else 0 end,
    case when p_outcome = 'incorrect' then 1 else 0 end,
    now(), now()
  )
  on conflict (student_id, concept_id) do update set
    p_mastery = p_new_mastery,
    evidence_count = learner_concept_state.evidence_count + 1,
    correct_count = learner_concept_state.correct_count + (case when p_outcome = 'correct' then 1 else 0 end),
    incorrect_count = learner_concept_state.incorrect_count + (case when p_outcome = 'incorrect' then 1 else 0 end),
    last_practiced_at = now()
  where learner_concept_state.p_mastery = p_prior_mastery
    and learner_concept_state.evidence_count = p_prior_evidence_count;

  get diagnostics v_rows_updated = row_count;

  if v_rows_updated = 0 then
    -- CAS conflict: another update landed between the caller's read and this write. Raising here
    -- rolls back the WHOLE function, including the transition insert above -- there is no window
    -- where a ledger row exists with a stale mastery_before and no matching state change.
    raise exception 'bkt_cas_conflict: learner_concept_state changed concurrently for student % concept %', p_student_id, p_concept_id
      using errcode = 'P0001';
  end if;

  select * into v_state from public.learner_concept_state
    where student_id = p_student_id and concept_id = p_concept_id;
  return query select 'applied'::text, v_state;
end;
$$;
