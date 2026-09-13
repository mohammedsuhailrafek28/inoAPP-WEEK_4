-- Week 3 Phase 2 -- small, representative seed fixture (Step 16).
--
-- This is NOT a curriculum. It exists only to prove, against real data, that the concept
-- registry and prerequisite graph work: subject grouping (3 subjects), a 3-deep prerequisite
-- chain, and a second, independent 2-node chain in a different subject.
--
-- Idempotent: safe to run against an already-seeded database. Concept identity is the unique
-- concept_key (ON CONFLICT DO UPDATE with the same value, purely so RETURNING still yields the
-- existing row -- this never changes a previously-seeded concept's data). Edges are similarly
-- safe to re-insert (ON CONFLICT DO NOTHING against the (concept_id, prerequisite_concept_id)
-- primary key).

with upserted as (
  insert into public.learning_concepts (id, subject, concept_key, display_name)
  values
    (gen_random_uuid(), 'algorithms', 'hashing', 'Hashing'),
    (gen_random_uuid(), 'algorithms', 'rolling-hash', 'Rolling Hash'),
    (gen_random_uuid(), 'algorithms', 'rabin-karp', 'Rabin-Karp'),
    (gen_random_uuid(), 'data-structures', 'arrays', 'Arrays'),
    (gen_random_uuid(), 'data-structures', 'binary-search', 'Binary Search'),
    (gen_random_uuid(), 'machine-learning', 'linear-regression', 'Linear Regression'),
    (gen_random_uuid(), 'machine-learning', 'logistic-regression', 'Logistic Regression')
  on conflict (concept_key) do update set concept_key = excluded.concept_key
  returning id, concept_key
)
insert into public.concept_prerequisites (concept_id, prerequisite_concept_id)
select dependent.id, prerequisite.id
from (
  values
    -- algorithms: hashing -> rolling-hash -> rabin-karp
    ('rolling-hash', 'hashing'),
    ('rabin-karp', 'rolling-hash'),
    -- data-structures: arrays -> binary-search
    ('binary-search', 'arrays'),
    -- machine-learning: linear-regression -> logistic-regression
    ('logistic-regression', 'linear-regression')
) as edge(dependent_key, prerequisite_key)
join upserted as dependent on dependent.concept_key = edge.dependent_key
join upserted as prerequisite on prerequisite.concept_key = edge.prerequisite_key
on conflict (concept_id, prerequisite_concept_id) do nothing;
