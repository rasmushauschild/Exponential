-- In-app egress metering: each device logs one row per day of bytes it moved through
-- the Supabase client; the app sums the month and warns moderators before the quota.

create table if not exists public.usage_log (
  device_id uuid not null,
  day date not null,
  user_id uuid references public.profiles on delete cascade,
  bytes_down bigint not null default 0,
  bytes_up bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (device_id, day)
);

alter table public.usage_log enable row level security;
drop policy if exists usage_write on public.usage_log;
create policy usage_write on public.usage_log for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists usage_read on public.usage_log;
create policy usage_read on public.usage_log for select to authenticated using (true);

-- One number instead of shipping rows to every client.
create or replace function public.usage_month_total()
returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(sum(bytes_down + bytes_up), 0)::bigint
  from public.usage_log
  where day >= date_trunc('month', now())::date;
$$;
