-- Saved artifacts: action plans, meeting agendas, reports (JSON payload)

create table if not exists action_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  title text,
  data jsonb not null default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists meeting_agendas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  title text,
  data jsonb not null default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  title text,
  data jsonb not null default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table action_plans enable row level security;
alter table meeting_agendas enable row level security;
alter table reports enable row level security;

create policy "Users see own action plans"
  on action_plans for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users see own meeting agendas"
  on meeting_agendas for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users see own reports"
  on reports for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
