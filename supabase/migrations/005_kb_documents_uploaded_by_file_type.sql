-- Safe to re-run: library columns for uploader + extension (if not already applied via 003)
alter table public.kb_documents
  add column if not exists uploaded_by uuid references public.profiles (id) on delete set null;

alter table public.kb_documents
  add column if not exists file_type text;

create index if not exists kb_documents_uploaded_by_idx on public.kb_documents (uploaded_by);
