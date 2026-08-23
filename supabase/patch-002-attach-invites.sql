-- When someone is invited by email and already has an account, link the membership immediately.
create or replace function public.attach_member()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.user_id is null then
    select id into new.user_id from public.profiles where lower(email) = lower(new.email);
  end if;
  new.email = lower(new.email);
  return new;
end $$;

drop trigger if exists team_members_attach on public.team_members;
create trigger team_members_attach before insert on public.team_members
  for each row execute function public.attach_member();
