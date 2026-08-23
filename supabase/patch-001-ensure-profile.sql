-- Creates the caller's profile row if the sign-up trigger didn't (e.g. the user existed before the schema).
create or replace function public.ensure_profile()
returns void language plpgsql security definer set search_path = public as $$
declare u record;
begin
  select id, email, raw_user_meta_data into u from auth.users where id = auth.uid();
  if u.id is null then raise exception 'not signed in'; end if;
  insert into public.profiles (id, email, name, photo)
  values (
    u.id,
    lower(u.email),
    coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', split_part(u.email, '@', 1)),
    coalesce(u.raw_user_meta_data->>'avatar_url', u.raw_user_meta_data->>'picture')
  )
  on conflict (id) do nothing;
  update public.team_members set user_id = u.id where user_id is null and lower(email) = lower(u.email);
end $$;
