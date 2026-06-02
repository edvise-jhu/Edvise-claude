-- Profiles, conversations, messages + RLS + auto-profile on signup.
-- Run against project actkvdwxakexyldfqajw (or any Supabase project).

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid references auth.users on delete cascade primary key,
  email text,
  name text,
  role text default 'teacher',
  school_name text,
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;

drop policy if exists "Users see own profile" on public.profiles;
create policy "Users see own profile"
  on public.profiles for all
  using (auth.uid() = id)
  with check (auth.uid() = id);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles (id) on delete cascade,
  title text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.conversations enable row level security;

drop policy if exists "Users see own conversations" on public.conversations;
create policy "Users see own conversations"
  on public.conversations for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.conversations (id) on delete cascade,
  role text,
  content text,
  metadata jsonb,
  created_at timestamptz default now()
);

alter table public.messages enable row level security;

drop policy if exists "Users see own messages" on public.messages;
create policy "Users see own messages"
  on public.messages for all
  using (
    conversation_id in (select id from public.conversations where user_id = auth.uid())
  )
  with check (
    conversation_id in (select id from public.conversations where user_id = auth.uid())
  );

-- Auto-create profile when a new auth user is created
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
