-- Project groups: a colour and a vertical section in the master plan.
create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  name text not null,
  color text not null default '#5b8def',
  sort int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists groups_team on public.groups(team_id);
alter table public.groups enable row level security;
drop policy if exists groups_member on public.groups;
create policy groups_member on public.groups for all to authenticated using (public.is_member(team_id)) with check (public.is_member(team_id));
alter table public.projects add column if not exists group_id uuid references public.groups(id) on delete set null;
do $$ begin
  execute 'alter publication supabase_realtime add table public.groups';
exception when duplicate_object then null; end $$;
