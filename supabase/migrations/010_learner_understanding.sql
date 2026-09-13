-- Week 3 Phase 6 -- evidence-backed learner understanding: misconceptions, transfer, calibration
-- (ARCHITECTURE.md §11, §12, §13, §20, §27).
--
-- Prerequisite readiness (§6) needs NO new table/columns -- it is derived on demand from
-- learning_concepts/concept_prerequisites (Phase 2) + learner_concept_state.p_mastery (Phase 3),
-- exactly per Step 26's "prefer derivation" instruction and §27's own table list, which never
-- mentions a readiness table.
--
-- Numbering note: the architecture's own illustrative phase table (§35) suggested
-- "009_misconceptions.sql" + "010_calibration.sql" as two files -- both slots have since drifted
-- (009 was consumed by Phase 5's retention migration). Per established precedent (Phase 5's own
-- numbering note), this is one migration, numbered next in sequence, covering everything Phase 6
-- needs; the split-vs-combined choice doesn't change any design decision below.

-- ---------------------------------------------------------------------------------------------
-- Transfer counters (§12): six plain integer columns on the SAME learner_concept_state row BKT/
-- FSRS already own -- §27 is explicit that transfer needs no new STATE table. A dedicated
-- transfer_evidence ledger (below) is still added for audit/idempotency, exactly the same
-- "state has no new table, but the audit ledger is separate infrastructure" pattern already
-- established for FSRS in migration 009 (§10.1 says retention fields live in learner_concept_state
-- with no table implied, yet a dedicated learner_retention_transitions ledger was still correct).
-- ---------------------------------------------------------------------------------------------

alter table public.learner_concept_state
  add column if not exists recall_attempts int not null default 0,
  add column if not exists recall_successes int not null default 0,
  add column if not exists application_attempts int not null default 0,
  add column if not exists application_successes int not null default 0,
  add column if not exists transfer_attempts int not null default 0,
  add column if not exists transfer_successes int not null default 0;

alter table public.learner_concept_state
  add constraint learner_concept_state_recall_counts_check check (recall_attempts >= 0 and recall_successes >= 0 and recall_successes <= recall_attempts),
  add constraint learner_concept_state_application_counts_check check (application_attempts >= 0 and application_successes >= 0 and application_successes <= application_attempts),
  add constraint learner_concept_state_transfer_counts_check check (transfer_attempts >= 0 and transfer_successes >= 0 and transfer_successes <= transfer_attempts);

create table if not exists public.transfer_evidence (
  id uuid primary key,
  student_id uuid not null references public.student_profiles(id) on delete cascade,
  concept_id uuid not null references public.learning_concepts(id) on delete restrict,
  -- Transfer's OWN idempotency boundary (Step 28), independent of BKT/IRT/FSRS/misconceptions: the
  -- same QUIZ_ANSWERED event can feed all of them, each exactly once, via its own UNIQUE constraint.
  source_event_id uuid not null unique references public.learning_events(id) on delete restrict,
  algorithm text not null default 'transfer' check (algorithm in ('transfer')),
  config_version int not null,
  level text not null check (level in ('recall', 'application', 'transfer')),
  score float not null check (score between 0 and 1),
  success boolean not null,
  -- §32's authority table: an evidence_trust label, never a claim of a 'trusted' tier that doesn't
  -- exist in this design -- llm_graded evidence still counts toward the counters, just labeled.
  evidence_trust text not null default 'deterministic' check (evidence_trust in ('deterministic', 'llm_graded')),
  created_at timestamptz not null default now()
);

create index if not exists transfer_evidence_student_concept_idx on public.transfer_evidence (student_id, concept_id, created_at);

alter table public.transfer_evidence enable row level security;

create trigger transfer_evidence_forbid_update
before update on public.transfer_evidence
for each row execute procedure public.forbid_row_mutation();

create trigger transfer_evidence_forbid_delete
before delete on public.transfer_evidence
for each row execute procedure public.forbid_row_mutation();

-- Atomic, idempotent, concurrency-safe transfer-counter update. CAS guard learns from the Phase 4
-- bug and Phase 5's proactive fix: an integer counter only (the sum of all three *_attempts
-- columns, which strictly increases by exactly 1 per applied evidence row regardless of which
-- level it targets), never a float or timestamp.
create or replace function public.apply_transfer_evidence(
  p_transition_id uuid,
  p_student_id uuid,
  p_concept_id uuid,
  p_source_event_id uuid,
  p_level text,
  p_score float,
  p_success boolean,
  p_evidence_trust text,
  p_prior_total_attempts int,
  p_config_version int
) returns table (status text, state public.learner_concept_state)
language plpgsql as $$
declare
  v_state public.learner_concept_state;
  v_rows_updated int;
begin
  if p_level not in ('recall', 'application', 'transfer') then
    raise exception 'invalid transfer level: %', p_level;
  end if;

  begin
    insert into public.transfer_evidence (
      id, student_id, concept_id, source_event_id, algorithm, config_version, level, score, success, evidence_trust
    ) values (
      p_transition_id, p_student_id, p_concept_id, p_source_event_id, 'transfer', p_config_version, p_level, p_score, p_success, p_evidence_trust
    );
  exception when unique_violation then
    select * into v_state from public.learner_concept_state
      where student_id = p_student_id and concept_id = p_concept_id;
    return query select 'already_processed'::text, v_state;
    return;
  end;

  -- Insert-branch placeholders for the shared row's BKT-owned NOT NULL columns mirror migration
  -- 009's identical note: never authoritative, overwritten the moment BKT actually runs.
  insert into public.learner_concept_state (
    student_id, concept_id, p_mastery, evidence_count, correct_count, incorrect_count,
    recall_attempts, recall_successes, application_attempts, application_successes,
    transfer_attempts, transfer_successes
  ) values (
    p_student_id, p_concept_id, 0.2, 0, 0, 0,
    case when p_level = 'recall' then 1 else 0 end, case when p_level = 'recall' and p_success then 1 else 0 end,
    case when p_level = 'application' then 1 else 0 end, case when p_level = 'application' and p_success then 1 else 0 end,
    case when p_level = 'transfer' then 1 else 0 end, case when p_level = 'transfer' and p_success then 1 else 0 end
  )
  on conflict (student_id, concept_id) do update set
    recall_attempts = learner_concept_state.recall_attempts + (case when p_level = 'recall' then 1 else 0 end),
    recall_successes = learner_concept_state.recall_successes + (case when p_level = 'recall' and p_success then 1 else 0 end),
    application_attempts = learner_concept_state.application_attempts + (case when p_level = 'application' then 1 else 0 end),
    application_successes = learner_concept_state.application_successes + (case when p_level = 'application' and p_success then 1 else 0 end),
    transfer_attempts = learner_concept_state.transfer_attempts + (case when p_level = 'transfer' then 1 else 0 end),
    transfer_successes = learner_concept_state.transfer_successes + (case when p_level = 'transfer' and p_success then 1 else 0 end)
  where (learner_concept_state.recall_attempts + learner_concept_state.application_attempts + learner_concept_state.transfer_attempts) = p_prior_total_attempts;

  get diagnostics v_rows_updated = row_count;

  if v_rows_updated = 0 then
    raise exception 'transfer_cas_conflict: learner_concept_state transfer counters changed concurrently for student % concept %', p_student_id, p_concept_id
      using errcode = 'P0001';
  end if;

  select * into v_state from public.learner_concept_state
    where student_id = p_student_id and concept_id = p_concept_id;
  return query select 'applied'::text, v_state;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Misconceptions (§11) -- a real lifecycle (candidate -> active -> resolved), evidence-backed,
-- stronger than the audited source. `status`/`evidence_count` are never LLM-writable (§32) --
-- lib/learning/misconceptions.ts::recordEvidence() is the sole writer.
-- ---------------------------------------------------------------------------------------------

create table if not exists public.misconceptions (
  id uuid primary key,
  student_id uuid not null references public.student_profiles(id) on delete cascade,
  concept_id uuid not null references public.learning_concepts(id) on delete restrict,
  -- Normalized machine-stable key (e.g. "off_by_one_boundary"), never free text -- Step 10.
  tag text not null check (char_length(tag) between 1 and 80),
  description text not null check (char_length(description) between 1 and 300),
  status text not null default 'candidate' check (status in ('candidate', 'active', 'resolved')),
  evidence_count int not null default 1 check (evidence_count >= 1),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (student_id, concept_id, tag)
);

create trigger misconceptions_set_updated_at
before update on public.misconceptions
for each row execute procedure public.set_updated_at();

alter table public.misconceptions enable row level security;

-- ---------------------------------------------------------------------------------------------
-- Append-only evidence ledger -- not itemized in §27's headline "12 tables" count (which also
-- omits learner_state_transitions/learner_ability_transitions/learner_retention_transitions, all
-- three already live), for the same reason: it's audit infrastructure per algorithm, not a second
-- conceptual state table. Its own independent UNIQUE(source_event_id): the same QUIZ_ANSWERED
-- event that feeds BKT/IRT/FSRS/transfer also independently feeds misconception evidence exactly
-- once (Step 28/40).
-- ---------------------------------------------------------------------------------------------

create table if not exists public.misconception_evidence (
  id uuid primary key,
  student_id uuid not null references public.student_profiles(id) on delete cascade,
  concept_id uuid not null references public.learning_concepts(id) on delete restrict,
  tag text not null check (char_length(tag) between 1 and 80),
  source_event_id uuid not null unique references public.learning_events(id) on delete restrict,
  algorithm text not null default 'misconception' check (algorithm in ('misconception')),
  config_version int not null,
  description text not null check (char_length(description) between 1 and 300),
  -- null only for the very first evidence row that created a brand-new candidate.
  status_before text null check (status_before in ('candidate', 'active', 'resolved')),
  status_after text not null check (status_after in ('candidate', 'active', 'resolved')),
  evidence_count_before int not null check (evidence_count_before >= 0),
  evidence_count_after int not null check (evidence_count_after >= 1),
  created_at timestamptz not null default now()
);

create index if not exists misconception_evidence_student_concept_tag_idx
  on public.misconception_evidence (student_id, concept_id, tag, created_at);

alter table public.misconception_evidence enable row level security;

create trigger misconception_evidence_forbid_update
before update on public.misconception_evidence
for each row execute procedure public.forbid_row_mutation();

create trigger misconception_evidence_forbid_delete
before delete on public.misconception_evidence
for each row execute procedure public.forbid_row_mutation();

-- Atomic, idempotent, concurrency-safe evidence application. The threshold/status-transition
-- DECISION is computed in lib/learning/misconceptions.ts (TypeScript) -- exactly like BKT/IRT/FSRS,
-- this function persists an already-computed p_new_status/p_new_evidence_count, it never
-- recomputes activation/resolution logic in SQL. CAS guard: the integer evidence_count only.
create or replace function public.apply_misconception_evidence(
  p_transition_id uuid,
  p_student_id uuid,
  p_concept_id uuid,
  p_source_event_id uuid,
  p_tag text,
  p_description text,
  p_prior_evidence_count int,
  p_new_evidence_count int,
  p_prior_status text,
  p_new_status text,
  p_config_version int
) returns table (status text, misconception public.misconceptions)
language plpgsql as $$
declare
  v_misconception public.misconceptions;
  v_existing_tag text;
  v_rows_updated int;
begin
  if p_new_status not in ('candidate', 'active', 'resolved') then
    raise exception 'invalid misconception status: %', p_new_status;
  end if;

  begin
    insert into public.misconception_evidence (
      id, student_id, concept_id, tag, source_event_id, algorithm, config_version, description,
      status_before, status_after, evidence_count_before, evidence_count_after
    ) values (
      p_transition_id, p_student_id, p_concept_id, p_tag, p_source_event_id, 'misconception', p_config_version, p_description,
      p_prior_status, p_new_status, p_prior_evidence_count, p_new_evidence_count
    );
  exception when unique_violation then
    select tag into v_existing_tag from public.misconception_evidence where source_event_id = p_source_event_id;
    select * into v_misconception from public.misconceptions
      where student_id = p_student_id and concept_id = p_concept_id and tag = v_existing_tag;
    return query select 'already_processed'::text, v_misconception;
    return;
  end;

  insert into public.misconceptions (
    id, student_id, concept_id, tag, description, status, evidence_count, first_seen_at, last_seen_at
  ) values (
    gen_random_uuid(), p_student_id, p_concept_id, p_tag, p_description, p_new_status, p_new_evidence_count, now(), now()
  )
  on conflict (student_id, concept_id, tag) do update set
    description = p_description,
    status = p_new_status,
    evidence_count = p_new_evidence_count,
    last_seen_at = now()
  where misconceptions.evidence_count = p_prior_evidence_count;

  get diagnostics v_rows_updated = row_count;

  if v_rows_updated = 0 then
    raise exception 'misconception_cas_conflict: misconceptions changed concurrently for student % concept % tag %', p_student_id, p_concept_id, p_tag
      using errcode = 'P0001';
  end if;

  select * into v_misconception from public.misconceptions
    where student_id = p_student_id and concept_id = p_concept_id and tag = p_tag;
  return query select 'applied'::text, v_misconception;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Calibration (§13) -- the ONE deliberate exception to "evidence is append-only": a record is
-- opened (confidence given before answering) then resolved exactly once (actual outcome known).
-- ---------------------------------------------------------------------------------------------

create table if not exists public.calibration_records (
  id uuid primary key,
  student_id uuid not null references public.student_profiles(id) on delete cascade,
  concept_id uuid null references public.learning_concepts(id) on delete restrict,
  predicted float not null check (predicted between 0 and 1),
  actual float null check (actual between 0 and 1),
  delta float null,
  -- Idempotency (Step 22): a source event can resolve at most one calibration record. Multiple
  -- OPEN records (source_event_id still null) are unaffected -- UNIQUE permits multiple NULLs.
  source_event_id uuid null unique references public.learning_events(id) on delete restrict,
  created_at timestamptz not null default now(),
  resolved_at timestamptz null,
  -- actual/delta/resolved_at/source_event_id are always filled in together, never partially.
  constraint calibration_records_resolution_pair check (
    (actual is null and delta is null and resolved_at is null and source_event_id is null)
    or (actual is not null and delta is not null and resolved_at is not null and source_event_id is not null)
  )
);

-- At most one OPEN (unresolved) prediction per (student, concept) at a time -- the caller must
-- resolve or the record stays open; this is the entire mechanism preventing ambiguous resolution
-- target selection, no extra bookkeeping column needed.
create unique index if not exists calibration_records_one_open_per_concept
  on public.calibration_records (student_id, concept_id)
  where actual is null;

create index if not exists calibration_records_student_resolved_idx
  on public.calibration_records (student_id, resolved_at desc)
  where resolved_at is not null;

alter table public.calibration_records enable row level security;
-- Deliberately NO forbid_row_mutation triggers here -- this is the one table the architecture
-- explicitly designs as mutable (open -> resolved). The only mutation path is the RPC below, which
-- itself only ever transitions actual: null -> not null exactly once per row.

create or replace function public.resolve_calibration_prediction(
  p_student_id uuid,
  p_concept_id uuid,
  p_source_event_id uuid,
  p_actual float,
  p_delta float
) returns table (status text, record public.calibration_records)
language plpgsql as $$
declare
  v_record public.calibration_records;
  v_rows_updated int;
begin
  select * into v_record from public.calibration_records where source_event_id = p_source_event_id;
  if found then
    return query select 'already_processed'::text, v_record;
    return;
  end if;

  update public.calibration_records
  set actual = p_actual, delta = p_delta, source_event_id = p_source_event_id, resolved_at = now()
  where student_id = p_student_id and concept_id = p_concept_id and actual is null
  returning * into v_record;

  get diagnostics v_rows_updated = row_count;

  if v_rows_updated = 0 then
    -- Not a CAS-retry situation (unlike BKT/IRT/FSRS/transfer/misconceptions): only one of two
    -- concurrent resolutions of the SAME open record can be legitimate, so the loser fails hard
    -- rather than silently retrying against different data.
    raise exception 'calibration_no_open_prediction: no open calibration prediction for student % concept %', p_student_id, p_concept_id
      using errcode = 'P0001';
  end if;

  return query select 'applied'::text, v_record;
end;
$$;
