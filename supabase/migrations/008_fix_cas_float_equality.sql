-- Week 3 Phase 4 -- fixes a genuine concurrency-safety bug discovered via live testing in both
-- apply_bkt_transition (migration 006, Phase 3) and apply_irt_transition (migration 007, Phase 4).
--
-- BUG: both functions' optimistic-concurrency (CAS) guard compared a FLOAT column
-- (learner_concept_state.p_mastery / learner_ability.theta) for exact equality against a value the
-- caller had read back through a Supabase/PostgREST JSON round-trip. A double-precision value can
-- lose its last bit or two of precision serializing to JSON text and back, so the stored value and
-- the round-tripped value can differ by 1 ULP while both DISPLAY identically -- causing the WHERE
-- clause to match zero rows and the function to report a CAS conflict on every single call, not
-- just under genuine concurrent writes. This was caught live in Phase 4 (a second, sequential,
-- non-concurrent IRT update failed every retry attempt).
--
-- FIX: drop the float-equality clause entirely. The integer evidence/observation counter already
-- present in the same WHERE clause is a complete, JSON-safe optimistic-concurrency guard on its
-- own: it strictly increments by exactly 1 per successful update, so an unchanged count is proof
-- nothing else modified the row since the caller's read. This is a strict improvement, not a
-- weakened guarantee -- the float comparison never added correctness beyond what the counter
-- alone already provided.
--
-- migration 007's source file has also been corrected in place (so a fresh database built from
-- 001-008 in order never sees the bug); this migration exists to patch databases -- including this
-- project's own -- where 006 and/or the original 007 already applied the buggy versions.

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
  where learner_concept_state.evidence_count = p_prior_evidence_count; -- integer-only CAS guard, see header note

  get diagnostics v_rows_updated = row_count;

  if v_rows_updated = 0 then
    raise exception 'bkt_cas_conflict: learner_concept_state changed concurrently for student % concept %', p_student_id, p_concept_id
      using errcode = 'P0001';
  end if;

  select * into v_state from public.learner_concept_state
    where student_id = p_student_id and concept_id = p_concept_id;
  return query select 'applied'::text, v_state;
end;
$$;

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
  where learner_ability.observation_count = p_prior_observation_count; -- integer-only CAS guard, see header note

  get diagnostics v_rows_updated = row_count;

  if v_rows_updated = 0 then
    raise exception 'irt_cas_conflict: learner_ability changed concurrently for student % subject %', p_student_id, p_subject
      using errcode = 'P0001';
  end if;

  select * into v_ability from public.learner_ability where student_id = p_student_id and subject = p_subject;
  return query select 'applied'::text, v_ability;
end;
$$;
