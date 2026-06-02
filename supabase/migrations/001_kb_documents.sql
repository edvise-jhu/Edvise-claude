-- EdVise knowledge base (run in Supabase → SQL Editor for a new project)
-- Fixes: PGRST205 Could not find the table 'public.kb_documents'

create table if not exists public.kb_documents (
  id uuid primary key default gen_random_uuid(),
  filename text not null,
  scope text not null default 'global',
  school_name text,
  status text not null default 'pending',
  anthropic_file_id text,
  tags jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists kb_documents_status_idx on public.kb_documents (status);
create index if not exists kb_documents_scope_idx on public.kb_documents (scope);

alter table public.kb_documents enable row level security;

-- Backend uses service_role JWT / secret; that role bypasses RLS in Supabase.
-- Add policies later if the browser client should query this table directly.
