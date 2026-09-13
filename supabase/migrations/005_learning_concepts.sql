-- Week 3 Phase 2 -- concept registry + lightweight prerequisite DAG (ARCHITECTURE.md §6).
--
-- Deliberately NOT here: any DB-level cycle-prevention mechanism (trigger, recursive CTE
-- constraint). §6 locks cycle prevention to application-code, edge-insert-time only ("Cycle
-- detection never runs on a read path; the graph is small ... so authoring-time validation is
-- sufficient") -- lib/learning/concepts.ts::addPrerequisite() is the one trusted path that
-- enforces it, mirroring Tutor MCP's own DFS-at-authoring-time approach. Duplicating that as a
-- second, DB-level mechanism would re-litigate an already-locked decision, not strengthen it.

create table if not exists public.learning_concepts (
  id uuid primary key,
  -- Both normalized via lib/learning/concepts.ts's normalizeSubjectKey()/normalizeConceptKey()
  -- before ever reaching this table -- canonical identity is deterministic string equality, never
  -- fuzzy matching, never DB-side normalization.
  subject text not null check (char_length(subject) between 1 and 60),
  concept_key text not null unique check (char_length(concept_key) between 1 and 80),
  display_name text not null check (char_length(display_name) between 1 and 120),
  -- Raw surface forms that normalized to this same concept_key (an audit trail populated
  -- automatically by createOrResolveConcept(), never a manual abbreviation-alias mechanism --
  -- see Phase 2's docs for why "kmp -> knuth-morris-pratt"-style aliasing is deferred).
  aliases text[] not null default '{}',
  -- BKT prior/learning-rate overrides (ARCHITECTURE.md §7.4) -- columns exist now so Phase 3
  -- needs no migration to start reading them; unused and unenforced until then.
  default_p_l0 float null check (default_p_l0 is null or default_p_l0 between 0 and 1),
  default_p_t float null check (default_p_t is null or default_p_t between 0 and 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists learning_concepts_subject_idx on public.learning_concepts (subject);

create trigger learning_concepts_set_updated_at
before update on public.learning_concepts
for each row execute procedure public.set_updated_at(); -- reuses migration 003's generic trigger fn

alter table public.learning_concepts enable row level security;
-- Phase 2 is still single-user: no end-user policy is claimed here, matching every other table.

create table if not exists public.concept_prerequisites (
  concept_id uuid not null references public.learning_concepts(id) on delete cascade,
  prerequisite_concept_id uuid not null references public.learning_concepts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (concept_id, prerequisite_concept_id),
  -- DB-level self-loop guard as defense-in-depth (application code already rejects this first,
  -- with a clear error message -- this CHECK exists so a self-loop can never land even from a
  -- future, differently-written code path).
  constraint concept_prerequisites_no_self_loop check (concept_id <> prerequisite_concept_id)
);

-- The primary key already indexes (concept_id, prerequisite_concept_id) for "prerequisites of X"
-- lookups; this covers the reverse direction ("dependents of X").
create index if not exists concept_prerequisites_prerequisite_idx on public.concept_prerequisites (prerequisite_concept_id);

alter table public.concept_prerequisites enable row level security;

-- ---------------------------------------------------------------------------------------------
-- Event-ledger FK upgrade (Step 14 / ARCHITECTURE.md §25's own note: "Phase 2 adds ... once
-- the referenced table exists"). concept_id stays nullable -- the current chat pipeline cannot
-- reliably attribute a question to one concept yet, and QUESTION_ASKED must remain valid without
-- one. ON DELETE SET NULL (not CASCADE): removing a concept must never silently delete historical
-- evidence, matching how learning_events.session_id already behaves.
-- ---------------------------------------------------------------------------------------------

alter table public.learning_events
  add constraint learning_events_concept_id_fkey
  foreign key (concept_id) references public.learning_concepts(id) on delete set null;
