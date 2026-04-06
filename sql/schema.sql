-- ============================================================
-- sofitech MCP Demo — Supabase Schema
-- Paste this into your Supabase project → SQL Editor → Run
-- ============================================================

-- 1. Enable pgvector (free, built into Supabase)
create extension if not exists vector;

-- 2. Documents table — stores chunked PDF text + embeddings
create table if not exists documents (
  id          uuid primary key default gen_random_uuid(),
  client_id   text not null,           -- e.g. "nawshad" — simple text, no FK needed for demo
  filename    text not null,
  doc_type    text default 'document', -- precedent | contract | policy | general
  chunk_index int  not null default 0,
  content     text not null,
  embedding   vector(1536),            -- text-embedding-3-small dimensions
  created_at  timestamptz default now()
);

-- 3. Vector search function — called by search_documents tool
create or replace function match_documents (
  query_embedding   vector(1536),
  client_id_filter  text,
  match_count       int default 5
)
returns table (
  id          uuid,
  filename    text,
  doc_type    text,
  content     text,
  similarity  float
)
language sql stable as $$
  select
    id, filename, doc_type, content,
    1 - (embedding <=> query_embedding) as similarity
  from documents
  where client_id = client_id_filter
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- 4. Audit log — every tool call is recorded
create table if not exists audit_log (
  id         uuid primary key default gen_random_uuid(),
  client_id  text not null,
  tool       text not null,
  query      text,
  result_summary text,
  created_at timestamptz default now()
);

-- 5. Index for fast vector search
create index if not exists documents_embedding_idx
  on documents using ivfflat (embedding vector_cosine_ops)
  with (lists = 50);
