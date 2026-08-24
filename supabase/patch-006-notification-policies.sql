-- Notifications RLS: re-assert the intended policies (fixes "new row violates
-- row-level security policy for table notifications" when notifying a teammate).
-- Any team member may create a notification for a teammate; you see and manage
-- your own, and the sender may also amend/retract what they sent (undo/redo
-- re-sends the same row, which takes the update path).
alter table public.notifications enable row level security;

drop policy if exists notif_read on public.notifications;
create policy notif_read on public.notifications for select to authenticated
  using (to_user = auth.uid() or from_user = auth.uid());

drop policy if exists notif_insert on public.notifications;
create policy notif_insert on public.notifications for insert to authenticated
  with check (public.is_member(team_id));

drop policy if exists notif_update on public.notifications;
create policy notif_update on public.notifications for update to authenticated
  using (to_user = auth.uid() or from_user = auth.uid());

drop policy if exists notif_delete on public.notifications;
create policy notif_delete on public.notifications for delete to authenticated
  using (to_user = auth.uid() or from_user = auth.uid());
