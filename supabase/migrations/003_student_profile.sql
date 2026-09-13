-- Week 3 Phase 1 -- student profile (ARCHITECTURE.md §4, §27).
--
-- Single-user/no-login for now (Auth Decision, unchanged from Revision 1): every learner-scoped
-- table introduced in Week 3 carries a student_id FK so real authentication can be layered in
-- later by changing only how "the current student" is resolved (lib/learning/profile.ts), never
-- by rebuilding this schema. This table is the one row every such FK points at.

create table if not exists public.student_profiles (
  id uuid primary key,
  -- Required for a *meaningful* profile, but DB-defaulted so a bootstrap row can exist before the
  -- student has necessarily opened the profile screen (lib/learning/profile.ts::getOrCreateDefaultProfile).
  -- Application validation still rejects an explicit empty/oversized value.
  display_name text not null default 'Student' check (char_length(display_name) between 1 and 80),
  academic_level text not null default 'Not specified' check (char_length(academic_level) between 1 and 60),
  subjects text[] not null default '{}',
  learning_goals text null,
  preferred_explanation_style text not null default 'simple'
    check (preferred_explanation_style in ('simple', 'detailed', 'exam')),
  preferred_difficulty text not null default 'auto'
    check (preferred_difficulty in ('auto', 'easy', 'medium', 'hard')),
  preferred_pace text not null default 'standard'
    check (preferred_pace in ('self-paced', 'standard', 'accelerated')),
  example_preference text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint student_profiles_subjects_bounded check (
    array_length(subjects, 1) is null or array_length(subjects, 1) <= 10
  ),
  constraint student_profiles_learning_goals_bounded check (
    learning_goals is null or char_length(learning_goals) <= 500
  ),
  constraint student_profiles_example_preference_bounded check (
    example_preference is null or char_length(example_preference) <= 500
  )
);

-- Generic trigger function (not reused from Week 2's document-specific set_document_updated_at,
-- even though the body is identical, to avoid a confusing cross-table name coupling in a fresh
-- migration file). Both simply set NEW.updated_at = now().
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger student_profiles_set_updated_at
before update on public.student_profiles
for each row execute procedure public.set_updated_at();

alter table public.student_profiles enable row level security;

-- Phase 1 is intentionally single-user, matching Week 2's own documented posture: no end-user
-- policy is claimed here. RLS stays enabled and the server-only service role manages all access.
-- Add owner_id enforcement and user-facing policies with real authentication in a later phase.
