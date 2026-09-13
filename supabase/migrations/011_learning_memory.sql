-- Week 3 Phase 7 -- narrative memory (ARCHITECTURE.md §5 Layer E, §5.1). Autonomy/scaffolding
-- (§15) and episodic memory (§5 Layer D) need NO new tables at all: autonomy/scaffolding are
-- derived on demand from existing evidence (learning_events, learner_concept_state,
-- calibration_records, learner_retention_transitions), and episodic memory lives directly on the
-- already-existing learning_sessions.concepts_touched/summary columns (migration 004) -- this
-- migration only adds the one genuinely new table §27 lists: narrative_memories.

create table if not exists public.narrative_memories (
  id uuid primary key,
  student_id uuid not null references public.student_profiles(id) on delete cascade,
  -- Not in §27's inline schema sketch, but necessary to implement §5.1's own locked rule literally
  -- ("a second ... observation ... proposed in a LATER session"): without recording which session
  -- a candidate was proposed in, "later session" has nothing to compare against except a fragile
  -- timestamp-range join. The same "the doc's inline sketch is illustrative, not the full literal
  -- migration" resolution already applied in Phase 5 (FSRS ledger) and Phase 6 (misconception/
  -- transfer ledgers) for additions that implement an explicitly-stated rule the sketch doesn't
  -- itself preclude.
  session_id uuid not null references public.learning_sessions(id) on delete cascade,
  content text not null check (char_length(content) between 1 and 300),
  status text not null default 'pending' check (status in ('pending', 'confirmed')),
  corroborated_by uuid null references public.narrative_memories(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists narrative_memories_student_status_idx
  on public.narrative_memories (student_id, status, created_at);

alter table public.narrative_memories enable row level security;
-- Deliberately no forbid_row_mutation triggers: status pending -> confirmed is a real, single,
-- deterministic transition (§5.1), not an append-only ledger -- the same category as
-- calibration_records' open -> resolved transition (Phase 6), not learning_events/*_transitions.
-- The only mutation path is lib/learning/memory.ts's deterministic corroboration check; no
-- generic update route is exposed anywhere (§31).
