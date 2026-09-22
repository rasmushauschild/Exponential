-- Chat (channels / messages / attachments) + Meetings (recordings, transcripts,
-- shared calendars). Idempotent, run whole in the SQL editor.

-- ─── Chat ────────────────────────────────────────────────────────────────

create table if not exists public.channels (
  id uuid primary key,
  team_id uuid not null references public.teams on delete cascade,
  name text not null,
  topic text,
  is_private boolean not null default false,
  created_by uuid references public.profiles,
  created_at timestamptz not null default now(),
  unique (team_id, name)
);

create table if not exists public.channel_members (
  channel_id uuid not null references public.channels on delete cascade,
  user_id uuid not null references public.profiles,
  last_read_at timestamptz not null default now(),
  primary key (channel_id, user_id)
);

create table if not exists public.messages (
  id uuid primary key,
  channel_id uuid not null references public.channels on delete cascade,
  team_id uuid not null references public.teams on delete cascade,
  author uuid references public.profiles,
  body text not null default '',
  attachments jsonb,          -- [{path,name,size,type,w?,h?}] in the 'chat' bucket
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists messages_channel_created on public.messages (channel_id, created_at desc);

-- Who may see a channel: any team member for public ones; creator + invited for private.
create or replace function public.can_see_channel(c uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.channels ch
    where ch.id = c and public.is_member(ch.team_id)
      and (not ch.is_private
           or ch.created_by = auth.uid()
           or exists (select 1 from public.channel_members m where m.channel_id = c and m.user_id = auth.uid()))
  );
$$;

create or replace function public.can_manage_channel(c uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.channels ch
    where ch.id = c and (ch.created_by = auth.uid() or public.is_moderator(ch.team_id))
  );
$$;

alter table public.channels enable row level security;
drop policy if exists channels_read on public.channels;
create policy channels_read on public.channels for select to authenticated using (public.can_see_channel(id));
drop policy if exists channels_insert on public.channels;
create policy channels_insert on public.channels for insert to authenticated
  with check (public.is_member(team_id) and created_by = auth.uid());
drop policy if exists channels_update on public.channels;
create policy channels_update on public.channels for update to authenticated using (public.can_manage_channel(id));
drop policy if exists channels_delete on public.channels;
create policy channels_delete on public.channels for delete to authenticated using (public.can_manage_channel(id));

alter table public.channel_members enable row level security;
drop policy if exists chmembers_read on public.channel_members;
create policy chmembers_read on public.channel_members for select to authenticated using (public.can_see_channel(channel_id));
drop policy if exists chmembers_insert on public.channel_members;
create policy chmembers_insert on public.channel_members for insert to authenticated
  with check (public.can_manage_channel(channel_id) or (user_id = auth.uid() and public.can_see_channel(channel_id)));
drop policy if exists chmembers_update on public.channel_members;
create policy chmembers_update on public.channel_members for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists chmembers_delete on public.channel_members;
create policy chmembers_delete on public.channel_members for delete to authenticated
  using (user_id = auth.uid() or public.can_manage_channel(channel_id));

alter table public.messages enable row level security;
drop policy if exists messages_read on public.messages;
create policy messages_read on public.messages for select to authenticated using (public.can_see_channel(channel_id));
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated
  with check (author = auth.uid() and public.can_see_channel(channel_id) and public.is_member(team_id));
drop policy if exists messages_update on public.messages;
create policy messages_update on public.messages for update to authenticated
  using (author = auth.uid() or public.is_moderator(team_id));
drop policy if exists messages_delete on public.messages;
create policy messages_delete on public.messages for delete to authenticated
  using (author = auth.uid() or public.is_moderator(team_id));

-- One round trip for the sidebar: my visible channels + unread counts.
create or replace function public.chat_state(t uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', ch.id, 'name', ch.name, 'topic', ch.topic, 'private', ch.is_private, 'createdBy', ch.created_by,
      'members', case when ch.is_private then (select coalesce(jsonb_agg(m2.user_id), '[]'::jsonb) from public.channel_members m2 where m2.channel_id = ch.id) else null end,
      'lastRead', m.last_read_at,
      'unread', (select count(*) from public.messages ms
                 where ms.channel_id = ch.id and ms.deleted_at is null
                   and ms.author is distinct from auth.uid()
                   and ms.created_at > coalesce(m.last_read_at, 'epoch'::timestamptz)),
      'lastAt', (select max(ms.created_at) from public.messages ms where ms.channel_id = ch.id and ms.deleted_at is null)
    ) order by ch.created_at), '[]'::jsonb)
  from public.channels ch
  left join public.channel_members m on m.channel_id = ch.id and m.user_id = auth.uid()
  where ch.team_id = t and public.is_member(t)
    and (not ch.is_private or ch.created_by = auth.uid() or m.user_id is not null);
$$;

-- ─── Meetings ────────────────────────────────────────────────────────────

create table if not exists public.meetings (
  id uuid primary key,
  team_id uuid not null references public.teams on delete cascade,
  owner uuid references public.profiles,
  title text not null default 'Untitled meeting',
  started_at timestamptz not null default now(),
  duration_secs int,
  audio_path text,            -- '<meeting_id>/audio.webm' in the 'meetings' bucket
  transcript jsonb,           -- [{t0, t1, text}]
  summary text,
  status text not null default 'recorded',  -- recorded | transcribing | ready | error
  is_open boolean not null default true,    -- whole team may open it
  access uuid[] not null default '{}',      -- extra people when not open
  created_at timestamptz not null default now()
);
create index if not exists meetings_team_started on public.meetings (team_id, started_at desc);

create or replace function public.can_see_meeting(mid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.meetings m
    where m.id = mid and (m.owner = auth.uid() or auth.uid() = any(m.access)
                          or (m.is_open and public.is_member(m.team_id)))
  );
$$;

alter table public.meetings enable row level security;
drop policy if exists meetings_read on public.meetings;
create policy meetings_read on public.meetings for select to authenticated using (public.can_see_meeting(id));
drop policy if exists meetings_insert on public.meetings;
create policy meetings_insert on public.meetings for insert to authenticated
  with check (public.is_member(team_id) and owner = auth.uid());
drop policy if exists meetings_update on public.meetings;
create policy meetings_update on public.meetings for update to authenticated
  using (owner = auth.uid() or public.is_moderator(team_id));
drop policy if exists meetings_delete on public.meetings;
create policy meetings_delete on public.meetings for delete to authenticated
  using (owner = auth.uid() or public.is_moderator(team_id));

-- Teammates' calendars, opt-in: each app pushes its next two weeks (title/start/end only).
create table if not exists public.calendar_shares (
  team_id uuid not null references public.teams on delete cascade,
  user_id uuid not null references public.profiles,
  events jsonb not null default '[]',
  updated_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
alter table public.calendar_shares enable row level security;
drop policy if exists calshares_read on public.calendar_shares;
create policy calshares_read on public.calendar_shares for select to authenticated using (public.is_member(team_id));
drop policy if exists calshares_write on public.calendar_shares;
create policy calshares_write on public.calendar_shares for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and public.is_member(team_id));

-- ─── Storage ─────────────────────────────────────────────────────────────
-- chat bucket: paths are '<team_id>/<uuid>-<filename>'
-- meetings bucket: paths are '<meeting_id>/audio.webm'

insert into storage.buckets (id, name, public) values ('chat', 'chat', false) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('meetings', 'meetings', false) on conflict (id) do nothing;

drop policy if exists chat_files_read on storage.objects;
create policy chat_files_read on storage.objects for select to authenticated
  using (bucket_id = 'chat' and public.is_member(((storage.foldername(name))[1])::uuid));
drop policy if exists chat_files_insert on storage.objects;
create policy chat_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'chat' and public.is_member(((storage.foldername(name))[1])::uuid));
drop policy if exists chat_files_delete on storage.objects;
create policy chat_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'chat' and (owner = auth.uid() or public.is_moderator(((storage.foldername(name))[1])::uuid)));

drop policy if exists meeting_files_read on storage.objects;
create policy meeting_files_read on storage.objects for select to authenticated
  using (bucket_id = 'meetings' and public.can_see_meeting(((storage.foldername(name))[1])::uuid));
drop policy if exists meeting_files_insert on storage.objects;
create policy meeting_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'meetings' and exists (
    select 1 from public.meetings m where m.id = ((storage.foldername(name))[1])::uuid and m.owner = auth.uid()));
drop policy if exists meeting_files_delete on storage.objects;
create policy meeting_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'meetings' and exists (
    select 1 from public.meetings m where m.id = ((storage.foldername(name))[1])::uuid
      and (m.owner = auth.uid() or public.is_moderator(m.team_id))));

-- ─── Realtime ────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['channels', 'channel_members', 'messages', 'meetings', 'calendar_shares'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
