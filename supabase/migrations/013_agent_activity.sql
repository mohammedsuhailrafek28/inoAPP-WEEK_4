-- Week 4, Phase C -- agent activity log (audit gap identified against the Week 4 internship
-- requirements). A minimal, human-explainable, append-only record of AUTONOMOUS DECISIONS the
-- planning/materials layer made -- deliberately NOT learning_events (migration 004): that table is
-- learner EVIDENCE (BKT/IRT/FSRS/PFA/transfer/misconception all consume it), and mixing an agent's
-- own "I generated a plan" bookkeeping into that ledger would risk corrupting those consumers'
-- semantics. This table has exactly one job: let the product answer "what did the agent decide, and
-- why," with no downstream algorithm ever reading from it.
--
-- Additive only -- no ALTER to any existing table, no destructive change.

create table if not exists public.agent_activity_log (
  id uuid primary key,
  student_id uuid not null references public.student_profiles(id) on delete cascade,
  subject text not null check (char_length(subject) between 1 and 60),
  -- A small, closed, human-explainable vocabulary -- kept intentionally short (Phase C's own
  -- instruction: "do not turn this into generic telemetry"). NEXT_ACTION_SELECTED is defined for
  -- schema completeness (a future phase may want to log every next-best-action computation) but has
  -- no call site yet today -- the same "define safely, no call site until a phase needs it"
  -- convention migration 004's own learning_events.event_type CHECK already established for
  -- LEARNING_EVENT_TYPES vs. EMITTABLE_EVENT_TYPES.
  kind text not null check (kind in ('PLAN_GENERATED', 'PLAN_REPLANNED', 'NEXT_ACTION_SELECTED', 'MATERIAL_GENERATED')),
  -- No FK to learning_concepts: a subject-level PLAN_GENERATED/PLAN_REPLANNED row may legitimately
  -- have no single concept (e.g. an empty plan for a fresh subject) -- nullable by design, mirroring
  -- migration 004's own learning_events.concept_id nullability rationale.
  concept_id uuid null references public.learning_concepts(id) on delete set null,
  concept_key text null,
  reason_codes text[] not null default '{}',
  metadata jsonb not null default '{}',
  constraint agent_activity_log_metadata_is_object check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists agent_activity_log_student_created_idx
  on public.agent_activity_log (student_id, created_at desc);

create index if not exists agent_activity_log_student_subject_created_idx
  on public.agent_activity_log (student_id, subject, created_at desc);

alter table public.agent_activity_log enable row level security;

-- Append-only, reusing migration 006's generic forbid_row_mutation() -- no new trigger function
-- needed, the same convention migrations 007/009/012 already followed for their own ledgers.
create trigger agent_activity_log_forbid_update
before update on public.agent_activity_log
for each row execute procedure public.forbid_row_mutation();

create trigger agent_activity_log_forbid_delete
before delete on public.agent_activity_log
for each row execute procedure public.forbid_row_mutation();

-- Still single-user: no end-user RLS policy is claimed here, matching every other table in this project.
