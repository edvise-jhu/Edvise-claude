-- supabase/schema.sql

-- Enable pgvector for embeddings
create extension if not exists vector;

-- Users / schools
create table profiles (
  id uuid references auth.users primary key,
  email text,
  name text,
  role text default 'teacher', -- 'teacher' | 'admin'
  school_name text,
  created_at timestamptz default now()
);

-- Conversations
create table conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id),
  title text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Messages
create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references conversations(id) on delete cascade,
  role text, -- 'user' | 'assistant'
  content text,
  metadata jsonb, -- stores analysis results, sources, etc.
  created_at timestamptz default now()
);

-- Uploaded data files
create table data_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id),
  filename text,
  file_path text, -- supabase storage path
  file_type text,
  row_count int,
  variable_mapping jsonb, -- confirmed variable mapping
  status text default 'pending', -- 'pending' | 'confirmed' | 'analyzed'
  created_at timestamptz default now()
);

-- Knowledge base documents
create table kb_documents (
  id uuid primary key default gen_random_uuid(),
  uploaded_by uuid references profiles(id),
  filename text,
  file_path text,
  scope text default 'global', -- 'global' | 'school'
  school_name text,
  status text default 'pending', -- 'pending' | 'approved' | 'rejected'
  approved_by uuid references profiles(id),
  created_at timestamptz default now()
);

-- Document chunks with embeddings (RAG)
create table document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references kb_documents(id) on delete cascade,
  content text,
  embedding vector(1536),
  chunk_index int,
  metadata jsonb
);

-- Action plans
create table action_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id),
  conversation_id uuid references conversations(id),
  title text,
  goal text,
  focus_group jsonb,
  weeks jsonb, -- array of week objects with actions
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Meeting agendas
create table meeting_agendas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id),
  conversation_id uuid references conversations(id),
  title text,
  date timestamptz,
  location text,
  attendees jsonb,
  purpose text,
  items jsonb,
  created_at timestamptz default now()
);

-- RLS policies
alter table profiles enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table data_files enable row level security;
alter table action_plans enable row level security;
alter table meeting_agendas enable row level security;

create policy "Users see own data" on profiles for all using (auth.uid() = id);
create policy "Users see own conversations" on conversations for all using (auth.uid() = user_id);
create policy "Users see own messages" on messages for all using (
  conversation_id in (select id from conversations where user_id = auth.uid())
);
create policy "Users see own files" on data_files for all using (auth.uid() = user_id);
create policy "Users see own plans" on action_plans for all using (auth.uid() = user_id);
create policy "Users see own agendas" on meeting_agendas for all using (auth.uid() = user_id);

-- Vector search function
create or replace function match_documents(
  query_embedding vector(1536),
  match_count int,
  scope_filter text default 'global'
)
returns table (
  id uuid,
  content text,
  filename text,
  scope text,
  similarity float
)
language sql stable
as $$
  select
    dc.id,
    dc.content,
    kd.filename,
    kd.scope,
    1 - (dc.embedding <=> query_embedding) as similarity
  from document_chunks dc
  join kb_documents kd on dc.document_id = kd.id
  where kd.status = 'approved'
    and (scope_filter = 'all' or kd.scope = scope_filter)
  order by dc.embedding <=> query_embedding
  limit match_count;
$$;

-- Auto-update conversations.updated_at
create or replace function update_conversation_timestamp()
returns trigger as $$
begin
  update conversations set updated_at = now() where id = new.conversation_id;
  return new;
end;
$$ language plpgsql;

create trigger on_message_insert
  after insert on messages
  for each row execute function update_conversation_timestamp();
