create or replace function public.match_document_chunks(
  query_embedding vector(768),
  selected_document_ids uuid[],
  match_threshold float,
  match_count integer
)
returns table (
  chunk_id text,
  document_id uuid,
  filename text,
  page_number integer,
  ordinal_on_page integer,
  text text,
  similarity float
)
language sql stable
as $$
  select c.id, c.document_id, d.display_name, c.page_number, c.ordinal_on_page, c.text,
         1 - (c.embedding <=> query_embedding) as similarity
  from public.document_chunks c
  join public.documents d on d.id = c.document_id
  where c.embedding is not null
    and d.status = 'ready'
    and c.document_id = any(selected_document_ids)
    and 1 - (c.embedding <=> query_embedding) >= match_threshold
  order by c.embedding <=> query_embedding
  limit least(greatest(match_count, 1), 10);
$$;
