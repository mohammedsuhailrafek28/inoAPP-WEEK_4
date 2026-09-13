-- Week 3 Phase 1 -- learning sessions + the immutable learning-event ledger
-- (ARCHITECTURE.md §25, §27, §31).

create table if not exists public.learning_sessions (
  id uuid primary key,
  student_id uuid not null references public.student_profiles(id) on delete cascade,
  subject text not null default 'general',
  status text not null default 'active' check (status in ('active', 'ended')),
  started_at timestamptz not null default now(),
  -- Bumped on every learning_events insert while this session is open -- the session's last
  -- meaningful-activity timestamp, and the sole input to staleness detection (§31). Never
  -- estimated, never client-supplied.
  last_active_at timestamptz not null default now(),
  ended_at timestamptz null,
  end_reason text null check (end_reason in ('explicit', 'superseded', 'stale_timeout')),
  concepts_touched uuid[] not null default '{}',   -- populated starting Phase 2, once concepts exist
  summary text null,                                -- llm_observed episodic recap; no writer until a later phase
  constraint learning_sessions_end_consistency check (
    (status = 'active' and ended_at is null and end_reason is null)
    or (status = 'ended' and ended_at is not null and end_reason is not null)
  )
);

-- One active session per student -- mirrors the Tutor-MCP-audited source's own invariant
-- (ARCHITECTURE.md §27); also what makes "supersede the prior session" in
-- start_learning_session() below race-safe rather than merely best-effort.
create unique index if not exists learning_sessions_one_active_per_student
  on public.learning_sessions (student_id)
  where status = 'active';

create index if not exists learning_sessions_student_started_idx
  on public.learning_sessions (student_id, started_at desc);

alter table public.learning_sessions enable row level security;

create table if not exists public.learning_events (
  id uuid primary key,
  student_id uuid not null references public.student_profiles(id) on delete cascade,
  session_id uuid null references public.learning_sessions(id) on delete set null,
  event_type text not null check (event_type in (
    -- Full catalog per ARCHITECTURE.md §25, so later phases never need to ALTER this
    -- constraint. Phase 1 only ever *emits* SESSION_STARTED / SESSION_ENDED / QUESTION_ASKED /
    -- EXPLANATION_VIEWED -- see types/learning.ts::PHASE1_EMITTABLE_EVENT_TYPES. Every other value
    -- below is structurally valid today but has zero call sites until its phase lands.
    'SESSION_STARTED', 'SESSION_ENDED', 'QUESTION_ASKED', 'EXPLANATION_VIEWED',
    'QUIZ_STARTED', 'QUIZ_ANSWERED', 'QUIZ_COMPLETED', 'HINT_REQUESTED',
    'CONFIDENCE_REPORTED', 'REVIEW_COMPLETED', 'TRANSFER_ATTEMPTED', 'MISCONCEPTION_OBSERVED'
  )),
  -- No FK yet: public.learning_concepts does not exist until Phase 2. Left as a bare nullable
  -- column on purpose ("nullable foreign keys that can be introduced safely later") -- Phase 2
  -- adds `alter table public.learning_events add constraint ... foreign key (concept_id)
  -- references public.learning_concepts(id)` once the referenced table exists.
  concept_id uuid null,
  idempotency_key text null check (idempotency_key is null or char_length(idempotency_key) <= 200),
  metadata jsonb not null default '{}',
  constraint learning_events_metadata_is_object check (jsonb_typeof(metadata) = 'object'),
  -- Server-resolved only -- see lib/learning/events.ts: no code path accepts a client-supplied
  -- value for either timestamp.
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Idempotency (Step 9): the same (student, idempotency_key) pair can never produce two rows. A
-- null key means "no idempotency requested for this event" and is exempt -- Postgres treats NULLs
-- as distinct for uniqueness purposes, which is exactly the semantics wanted here. This is
-- deliberately the entire idempotency mechanism (ARCHITECTURE.md §20): one column, one
-- partial unique index, not a CAS/replay subsystem.
create unique index if not exists learning_events_idempotency_unique
  on public.learning_events (student_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists learning_events_student_occurred_idx
  on public.learning_events (student_id, occurred_at desc);

create index if not exists learning_events_session_idx
  on public.learning_events (session_id) where session_id is not null;

alter table public.learning_events enable row level security;

-- Practical immutability (Step 8 / ARCHITECTURE.md §20, §25): no application code path ever
-- updates or deletes a learning_events row. That discipline is enforced primarily by the
-- repository surface (lib/learning/events.ts exposes only create + read, mirrored by
-- ProfileDependencies-style tests asserting no update/delete method exists), and reinforced here
-- at the database level so a coding mistake elsewhere on the server can never silently mutate
-- evidence -- even though the service-role connection could otherwise do anything, RLS having no
-- end-user policy.
--
-- This is a deliberate, disableable guard, not a permanent lock: legitimate maintenance (a GDPR-
-- style deletion request, a manual data-repair) must explicitly run, ONE TRIGGER PER STATEMENT
-- (Postgres's ALTER TABLE ... DISABLE TRIGGER does not accept a comma-separated list):
--   alter table public.learning_events disable trigger learning_events_forbid_update;
--   alter table public.learning_events disable trigger learning_events_forbid_delete;
-- perform the operation, then re-enable both the same way with ENABLE TRIGGER. This live-verified
-- (Phase 1 smoke test) "break glass" path is auditable and explicit, never a silently-flippable
-- runtime flag -- and it correctly blocks even a cascading DELETE from student_profiles until
-- deliberately disabled first, which is exactly the intended strength of the guard.
create or replace function public.forbid_learning_event_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'learning_events is append-only: % is not permitted', tg_op;
end;
$$;

create trigger learning_events_forbid_update
before update on public.learning_events
for each row execute procedure public.forbid_learning_event_mutation();

create trigger learning_events_forbid_delete
before delete on public.learning_events
for each row execute procedure public.forbid_learning_event_mutation();

-- Phase 1 is intentionally single-user: no end-user policy is claimed here. RLS stays enabled and
-- the server-only service role manages all access, matching every other table in this project.

-- ---------------------------------------------------------------------------------------------
-- Atomic session-lifecycle operations (Step 15). A session's state change and its own
-- SESSION_STARTED/SESSION_ENDED ledger event must never exist without each other -- these two
-- functions are the one deliberate exception to "every event goes through the generic
-- recordLearningEvent() service" (lib/learning/events.ts), specifically because a plpgsql function
-- body already runs inside one implicit transaction, which is the simplest correct way to couple
-- them without introducing a distributed-transaction mechanism this project has no other need for.
-- All other event types (QUESTION_ASKED now; QUIZ_ANSWERED etc. in later phases) always go through
-- recordLearningEvent() and land in this same table with the same shape.
-- ---------------------------------------------------------------------------------------------

create or replace function public.start_learning_session(
  p_student_id uuid,
  p_subject text,
  p_session_id uuid,
  p_event_id uuid,
  p_idempotency_key text default null
) returns public.learning_sessions
language plpgsql as $$
declare
  v_existing_session_id uuid;
  v_session public.learning_sessions;
begin
  if p_idempotency_key is not null then
    select session_id into v_existing_session_id
      from public.learning_events
      where student_id = p_student_id and idempotency_key = p_idempotency_key and event_type = 'SESSION_STARTED'
      limit 1;
    if v_existing_session_id is not null then
      select * into v_session from public.learning_sessions where id = v_existing_session_id;
      return v_session;
    end if;
  end if;

  -- A new explicit learning session may close the previous one (§31) -- a student is never left
  -- with two "active" sessions. The partial unique index above would reject the insert below
  -- outright if this update were skipped, so this is not optional bookkeeping.
  update public.learning_sessions
    set status = 'ended', ended_at = now(), end_reason = 'superseded'
    where student_id = p_student_id and status = 'active';

  insert into public.learning_sessions (id, student_id, subject, status, started_at, last_active_at)
  values (p_session_id, p_student_id, coalesce(p_subject, 'general'), 'active', now(), now())
  returning * into v_session;

  insert into public.learning_events (id, student_id, session_id, event_type, idempotency_key, metadata, occurred_at)
  values (p_event_id, p_student_id, v_session.id, 'SESSION_STARTED', p_idempotency_key, jsonb_build_object('subject', v_session.subject), now());

  return v_session;
end;
$$;

create or replace function public.end_learning_session(
  p_session_id uuid,
  p_student_id uuid,
  p_end_reason text,
  p_event_id uuid,
  p_idempotency_key text default null
) returns public.learning_sessions
language plpgsql as $$
declare
  v_existing_event_count int;
  v_session public.learning_sessions;
begin
  if p_end_reason not in ('explicit', 'superseded', 'stale_timeout') then
    raise exception 'invalid end_reason: %', p_end_reason;
  end if;

  if p_idempotency_key is not null then
    select count(*) into v_existing_event_count
      from public.learning_events
      where student_id = p_student_id and idempotency_key = p_idempotency_key and event_type = 'SESSION_ENDED';
    if v_existing_event_count > 0 then
      select * into v_session from public.learning_sessions where id = p_session_id;
      return v_session;
    end if;
  end if;

  update public.learning_sessions
    set status = 'ended', ended_at = now(), end_reason = p_end_reason
    where id = p_session_id and student_id = p_student_id and status = 'active'
  returning * into v_session;

  if v_session.id is null then
    -- Already ended (e.g. a genuine race with a stale-timeout check) -- ending an already-ended
    -- session is a safe no-op, not an error; return the current row as-is.
    select * into v_session from public.learning_sessions where id = p_session_id and student_id = p_student_id;
    return v_session;
  end if;

  insert into public.learning_events (id, student_id, session_id, event_type, idempotency_key, metadata, occurred_at)
  values (p_event_id, p_student_id, p_session_id, 'SESSION_ENDED', p_idempotency_key, jsonb_build_object('end_reason', p_end_reason), now());

  return v_session;
end;
$$;
