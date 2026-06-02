-- Run in Supabase SQL editor (Step 1)
alter table kb_documents add column if not exists anthropic_file_id text;
alter table kb_documents add column if not exists tags jsonb default '[]';

drop table if exists document_chunks;
drop function if exists match_documents;
