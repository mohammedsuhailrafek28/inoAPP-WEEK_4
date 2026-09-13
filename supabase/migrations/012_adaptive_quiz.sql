-- Week 3 Phase 9 -- adaptive grounded quiz system: §17.1's phase FSM + §17.2's anti-repeat state
-- (piggybacked onto learner_ability, no new table), and the quiz schema (§18/§19/§20/§27).
--
-- Scope decision (documented per established precedent, e.g. migration 010's numbering note):
-- §28 locks `/api/quiz/generate` to internally call `/api/learning/next-activity`, a subject-scoped,
-- server-picks-the-concept endpoint that needs §17.1 (phase) + §17.2 (concept selection), both
-- explicitly deferred out of Phase 8's scope (see types/learning.ts's PedagogicalDecisionInput
-- header comment). This migration builds the deferred columns now, since Phase 9's own locked API
-- contract cannot be satisfied without them.

-- ---------------------------------------------------------------------------------------------
-- §17.1 phase FSM + §17.2 anti-repeat pointer -- both piggybacked onto learner_ability exactly as
-- §27 locks it ("learner_ability ... + §17.1's phase column"), no new table.
-- ---------------------------------------------------------------------------------------------

alter table public.learner_ability
  add column if not exists phase text not null default 'DIAGNOSTIC' check (phase in ('DIAGNOSTIC', 'INSTRUCTION', 'MAINTENANCE')),
  add column if not exists phase_changed_at timestamptz null,
  -- Anti-repeat (§17.2 override 3: "exclude the concept selected in the immediately-previous
  -- activity unless rule 1 or 2 applies to it") needs to know what that concept was. A single
  -- pointer column is sufficient -- the cascade only ever needs the ONE most recent selection.
  add column if not exists last_selected_concept_id uuid null references public.learning_concepts(id) on delete set null,
  add column if not exists last_selected_at timestamptz null;

-- ---------------------------------------------------------------------------------------------
-- Quiz schema (§18/§27). "Unchanged from Revision 1" in the locked doc refers to an earlier draft
-- of this same architecture document, not to any pre-existing Week 2 code -- Week 2 (confirmed by
-- reading lib/documents/* in full before writing this migration) has no quiz feature of any kind,
-- only the chat/RAG document-Q&A pipeline. The exact column list below is this phase's own design,
-- built from §27's fragment ("+ subject/action/target_concept_id columns" / "+ concept_id FK,
-- irt_difficulty_b float, transfer_dimension text") plus §19/§20's stated behavior (idempotent-by-
-- construction submission, immutable scored history, server-reconstructed citations) and Week 2's
-- own citation/provenance shape (lib/documents/citations.ts's Citation type) reused verbatim for
-- quiz_questions.citations.
-- ---------------------------------------------------------------------------------------------

create table if not exists public.quizzes (
  id uuid primary key,
  student_id uuid not null references public.student_profiles(id) on delete cascade,
  session_id uuid null references public.learning_sessions(id) on delete set null,
  subject text not null check (char_length(subject) between 1 and 60),
  -- The §17.3 action that triggered generation (§18's diagram: only these four route to a quiz) --
  -- an audit trail for WHY this quiz exists, per §27's own stated column purpose.
  action text not null check (action in ('QUIZ', 'TRANSFER_CHALLENGE', 'SPACED_REVIEW', 'PREREQUISITE_REMEDIATION')),
  target_concept_id uuid not null references public.learning_concepts(id) on delete restrict,
  difficulty text not null check (difficulty in ('easy', 'medium', 'hard')),
  status text not null default 'in_progress' check (status in ('in_progress', 'submitted', 'abandoned')),
  score float null check (score is null or score between 0 and 1),
  created_at timestamptz not null default now(),
  submitted_at timestamptz null
);

create index if not exists quizzes_student_idx on public.quizzes (student_id, created_at desc);

alter table public.quizzes enable row level security;

create table if not exists public.quiz_questions (
  id uuid primary key,
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  concept_id uuid not null references public.learning_concepts(id) on delete restrict,
  question_type text not null check (question_type in ('mcq', 'short_answer')),
  question_text text not null check (char_length(question_text) between 1 and 2000),
  -- mcq only; null for short_answer. A jsonb array of option strings, never the correct answer.
  options jsonb null,
  -- Never sent to the client (lib/quiz/service.ts's client-facing mapper omits this column
  -- entirely) -- mcq: must equal one option verbatim; short_answer: a reference/rubric answer used
  -- only by Gemini's grading call, itself server-side (§32: "Quiz correctness (MCQ) ... Authoritative
  -- writer: Deterministic string compare"; short-answer grading is Gemini-assisted but still never
  -- client-supplied).
  correct_answer text not null check (char_length(correct_answer) between 1 and 2000),
  explanation text not null check (char_length(explanation) between 1 and 2000),
  -- §9.2's fixed mapping, assigned at generation/validation time, never Gemini-chosen.
  irt_difficulty_b float not null check (irt_difficulty_b in (-1.0, 0.0, 1.0)),
  transfer_dimension text not null check (transfer_dimension in ('recall', 'application', 'transfer')),
  -- Server-reconstructed provenance ONLY -- an array of {citationId,documentId,chunkId,filename,
  -- pageNumber} objects copied from the same labeled-evidence map lib/documents/citations.ts
  -- already builds for chat RAG (Step 12: "never a Gemini-written citation string").
  citations jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists quiz_questions_quiz_idx on public.quiz_questions (quiz_id);
create index if not exists quiz_questions_concept_idx on public.quiz_questions (concept_id);

alter table public.quiz_questions enable row level security;

create table if not exists public.quiz_answers (
  id uuid primary key,
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  question_id uuid not null references public.quiz_questions(id) on delete cascade,
  student_id uuid not null references public.student_profiles(id) on delete cascade,
  submitted_answer text not null,
  correct boolean not null,
  score float not null check (score between 0 and 1),
  evidence_trust text not null check (evidence_trust in ('deterministic', 'llm_graded')),
  feedback text null,
  response_time_ms int null check (response_time_ms is null or response_time_ms >= 0),
  -- The QUIZ_ANSWERED event this answer's BKT/IRT/FSRS/transfer evidence derives from -- one answer,
  -- one event, enforced by this FK's implicit 1:1 pairing with learning_events' own row.
  source_event_id uuid not null references public.learning_events(id) on delete restrict,
  created_at timestamptz not null default now(),
  -- §20's stated idempotency mechanism verbatim: "quiz_answers has UNIQUE(quiz_id, question_id)" --
  -- a resubmit against an already-answered question is rejected/short-circuited, never reapplied.
  unique (quiz_id, question_id)
);

create index if not exists quiz_answers_student_idx on public.quiz_answers (student_id, created_at desc);

alter table public.quiz_answers enable row level security;

-- Immutability of scored history (Step 21/§20): once written, a quiz_answers row is never updated
-- or deleted by application code -- the same append-only pattern already enforced by trigger on
-- every other transition ledger in this schema (migrations 006/007/009/010/011's
-- forbid_row_mutation()), reused verbatim here rather than inventing a second mechanism.
create trigger quiz_answers_forbid_update
before update on public.quiz_answers
for each row execute procedure public.forbid_row_mutation();

create trigger quiz_answers_forbid_delete
before delete on public.quiz_answers
for each row execute procedure public.forbid_row_mutation();

-- Phase 9 is still single-user: no end-user RLS policy is claimed here, matching every other table.
