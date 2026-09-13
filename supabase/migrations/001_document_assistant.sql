create extension if not exists vector;

create table if not exists public.documents (
  id uuid primary key,
  owner_id uuid null,
  original_filename text not null,
  display_name text not null,
  storage_path text not null unique,
  mime_type text not null check (mime_type = 'application/pdf'),
  byte_size bigint not null check (byte_size > 0 and byte_size <= 20971520),
  content_hash text not null,
  status text not null check (status in ('queued', 'extracting', 'chunking', 'embedding', 'ready', 'failed', 'needs_ocr')),
  failure_reason text null,
  page_count integer null check (page_count is null or page_count >= 0),
  chunk_count integer not null default 0 check (chunk_count >= 0),
  embedding_model text null,
  embedding_dimensions integer null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  processed_at timestamptz null
);

create table if not exists public.document_chunks (
  id text primary key,
  document_id uuid not null references public.documents(id) on delete cascade,
  page_number integer not null check (page_number >= 1),
  ordinal_on_page integer not null check (ordinal_on_page >= 1),
  text text not null,
  token_count integer not null check (token_count > 0),
  content_hash text not null,
  embedding vector(768) null,
  created_at timestamptz not null default now(),
  unique (document_id, page_number, ordinal_on_page)
);

create index if not exists document_chunks_document_page_idx on public.document_chunks (document_id, page_number, ordinal_on_page);
create index if not exists document_chunks_embedding_hnsw_idx on public.document_chunks using hnsw (embedding vector_cosine_ops) where embedding is not null;

create or replace function public.set_document_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger documents_set_updated_at
before update on public.documents
for each row execute procedure public.set_document_updated_at();

alter table public.documents enable row level security;
alter table public.document_chunks enable row level security;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 20971520, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 20971520, allowed_mime_types = array['application/pdf'];

-- Phase 1 is intentionally single-user: no end-user policy is claimed here.
-- RLS stays enabled and the server-only service role manages data and Storage.
-- Add owner_id enforcement and user-facing policies with real authentication in a later phase.
