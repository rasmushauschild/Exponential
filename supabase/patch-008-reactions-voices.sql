-- Chat reactions + voice prints (speaker recognition). Additive only.

alter table public.messages add column if not exists reactions jsonb;

-- One voice embedding per user ("Learn my voice"); readable by anyone who shares a
-- team with them, so transcripts can name enrolled teammates automatically.
create table if not exists public.voice_prints (
  user_id uuid primary key references public.profiles on delete cascade,
  embedding real[] not null,
  updated_at timestamptz not null default now()
);

create or replace function public.shares_team_with(u uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select u = auth.uid() or exists (
    select 1 from public.team_members a
    join public.team_members b on a.team_id = b.team_id
    where a.user_id = auth.uid() and b.user_id = u
  );
$$;

alter table public.voice_prints enable row level security;
drop policy if exists voice_read on public.voice_prints;
create policy voice_read on public.voice_prints for select to authenticated using (public.shares_team_with(user_id));
drop policy if exists voice_write on public.voice_prints;
create policy voice_write on public.voice_prints for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
