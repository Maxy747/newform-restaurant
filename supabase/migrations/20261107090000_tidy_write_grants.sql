begin;
-- Defence in depth: these table-level write grants were never usable (RLS has no policy allowing
-- them), but they shouldn't exist. Anonymous visitors never write these tables directly; signed-in
-- users never write order_signals / restaurant_roles / site_owners (the server does, as service_role).
-- Kept: authenticated writes on menu_items (admin RLS policy) and profiles (own row, safe columns).
do $$
declare t text;
begin
 foreach t in array array['menu_items','order_signals','profiles','restaurant_roles','site_owners'] loop
  if to_regclass('public.'||t) is not null then
   execute format('revoke insert, update, delete on public.%I from anon', t);
  end if;
 end loop;
 foreach t in array array['order_signals','restaurant_roles','site_owners'] loop
  if to_regclass('public.'||t) is not null then
   execute format('revoke insert, update, delete on public.%I from authenticated', t);
  end if;
 end loop;
 -- profiles: anon had column-level UPDATE on role; remove it explicitly too.
 if to_regclass('public.profiles') is not null then
  execute 'revoke update on public.profiles from anon';
 end if;
end $$;
commit;
