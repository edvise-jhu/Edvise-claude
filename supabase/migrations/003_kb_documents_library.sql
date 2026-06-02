-- Library view: uploader, file type, category (run in Supabase SQL Editor if not applied)

alter table public.kb_documents
  add column if not exists uploaded_by uuid references public.profiles (id) on delete set null;

alter table public.kb_documents
  add column if not exists file_type text;

alter table public.kb_documents
  add column if not exists category text;

create index if not exists kb_documents_uploaded_by_idx on public.kb_documents (uploaded_by);
