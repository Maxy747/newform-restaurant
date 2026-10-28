begin;
-- Owner (Max) sits above the restaurant's admins: the owner always has every capability and
-- decides what restaurant admins may use (checkout_settings.admin_access), and manages the team.

create table if not exists public.site_owners (
 user_id uuid primary key references auth.users(id) on delete cascade,
 created_at timestamptz not null default now()
);
alter table public.site_owners enable row level security;
grant all on public.site_owners to service_role;

-- What restaurant admins can use. Tabs: counter, tickets, drivers, reports, billing, menu;
-- settings groups: operations (online ordering, COD, delivery), design (website look and
-- gallery), money (invoice settings, refunds, Reduce bill). The owner can always do all of it.
alter table public.checkout_settings add column if not exists admin_access jsonb not null default
 '{"counter":true,"tickets":true,"drivers":true,"reports":true,"billing":true,"menu":false,"operations":true,"design":false,"money":true}'::jsonb;

create or replace function public.oms_is_owner(p_actor uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select p_actor is not null and exists(select 1 from public.site_owners where user_id=p_actor)
$$;

-- Owner: always. Restaurant admin: when the owner allows it. Until an owner exists, profile
-- admins keep their full access so nothing locks up.
create or replace function public.oms_actor_can(p_actor uuid, p_cap text) returns boolean
language sql stable security definer set search_path='' as $$
 select p_actor is not null and (
  public.oms_is_owner(p_actor)
  or (not exists(select 1 from public.site_owners) and exists(select 1 from public.profiles where id=p_actor and role='admin'))
  or (public.oms_actor_role(p_actor)='admin' and coalesce((select (admin_access->>p_cap)::boolean from public.checkout_settings where id), false))
 )
$$;
revoke execute on function public.oms_is_owner(uuid) from public, anon, authenticated;
revoke execute on function public.oms_actor_can(uuid,text) from public, anon, authenticated;
grant execute on function public.oms_is_owner(uuid) to service_role;
grant execute on function public.oms_actor_can(uuid,text) to service_role;

-- For row-level security: the signed-in user's own capability.
create or replace function public.oms_i_can(p_cap text) returns boolean
language sql stable security definer set search_path='' as $$
 select public.oms_actor_can((select auth.uid()), p_cap)
$$;
revoke execute on function public.oms_i_can(text) from public, anon;
grant execute on function public.oms_i_can(text) to authenticated, service_role;

-- Menu (dishes, categories, dish photos) follows the "menu" switch.
drop policy if exists "Admins manage menu items" on public.menu_items;
create policy "Admins manage menu items" on public.menu_items for all to authenticated
 using (public.oms_i_can('menu')) with check (public.oms_i_can('menu'));
drop policy if exists "Admins add categories" on public.menu_categories;
drop policy if exists "Admins edit categories" on public.menu_categories;
create policy "Admins add categories" on public.menu_categories for insert to authenticated with check (public.oms_i_can('menu'));
create policy "Admins edit categories" on public.menu_categories for update to authenticated
 using (public.oms_i_can('menu')) with check (public.oms_i_can('menu'));
drop policy if exists "Admins manage menu images" on storage.objects;
create policy "Admins manage menu images" on storage.objects for all to authenticated
 using (bucket_id = 'menu-images' and public.oms_i_can('menu'))
 with check (bucket_id = 'menu-images' and public.oms_i_can('menu'));

-- The website gallery follows the "design" switch.
drop policy if exists "Admins add gallery photos" on public.gallery_photos;
drop policy if exists "Admins edit gallery photos" on public.gallery_photos;
drop policy if exists "Admins delete gallery photos" on public.gallery_photos;
create policy "Admins add gallery photos" on public.gallery_photos for insert to authenticated with check (public.oms_i_can('design'));
create policy "Admins edit gallery photos" on public.gallery_photos for update to authenticated
 using (public.oms_i_can('design')) with check (public.oms_i_can('design'));
create policy "Admins delete gallery photos" on public.gallery_photos for delete to authenticated using (public.oms_i_can('design'));
drop policy if exists "Admins manage gallery photos" on storage.objects;
create policy "Admins manage gallery photos" on storage.objects for all to authenticated
 using (bucket_id = 'gallery-photos' and public.oms_i_can('design'))
 with check (bucket_id = 'gallery-photos' and public.oms_i_can('design'));

-- Team: everyone with restaurant access (owner, admins, staff, kitchen, delivery), with emails.
create or replace function public.oms_team() returns table(user_id uuid, email text, role text)
language sql stable security definer set search_path='' as $$
 select u.id, lower(u.email::text),
  case when o.user_id is not null then 'owner' when p.role='admin' then 'admin' else r.role end
 from auth.users u
 left join public.site_owners o on o.user_id=u.id
 left join public.profiles p on p.id=u.id
 left join public.restaurant_roles r on r.user_id=u.id
 where o.user_id is not null or p.role='admin' or r.role is not null
 order by case when o.user_id is not null then 0 when p.role='admin' or r.role='admin' then 1 when r.role='staff' then 2 when r.role='kitchen' then 3 else 4 end, lower(u.email::text)
$$;

-- Owner only: give an account admin, staff or kitchen access, or remove it ('none').
-- Delivery drivers stay in the Drivers tab; the owner account can't be changed here.
create or replace function public.oms_set_team_role(p_actor uuid, p_email text, p_role text) returns uuid
language plpgsql security definer set search_path='' as $$
declare uid uuid;
begin
 if not public.oms_is_owner(p_actor) then raise exception 'Owner access required'; end if;
 if p_role not in ('admin','staff','kitchen','none') then raise exception 'Pick Admin, Staff or Kitchen'; end if;
 if coalesce(trim(p_email),'') !~ '^[^@\s]+@[^@\s]+$' then raise exception 'Enter the email they signed up with'; end if;
 uid=public.oms_user_id_by_email(p_email);
 if uid is null then raise exception 'No account uses that email. Ask them to sign up on the website first, then add them here.'; end if;
 if public.oms_is_owner(uid) then raise exception 'That is the owner account'; end if;
 if exists(select 1 from public.restaurant_roles where user_id=uid and role='delivery') then
  raise exception 'That account is a delivery driver. Manage it in the Drivers tab.';
 end if;
 -- A legacy profile admin would override the role below, so it becomes a normal profile.
 update public.profiles set role='staff' where id=uid and role='admin';
 if p_role='none' then
  delete from public.restaurant_roles where user_id=uid;
 else
  insert into public.restaurant_roles(user_id,role) values(uid,p_role) on conflict(user_id) do update set role=excluded.role;
 end if;
 return uid;
end $$;
revoke execute on function public.oms_team() from public, anon, authenticated;
revoke execute on function public.oms_set_team_role(uuid,text,text) from public, anon, authenticated;
grant execute on function public.oms_team() to service_role;
grant execute on function public.oms_set_team_role(uuid,text,text) to service_role;

-- Max is the owner. The owner also holds the admin role, which the order, counter and driver
-- functions check.
insert into public.site_owners(user_id)
select uid from (select public.oms_user_id_by_email('mazinworlds@gmail.com') uid) s where uid is not null
on conflict do nothing;
insert into public.restaurant_roles(user_id,role) select user_id,'admin' from public.site_owners
on conflict(user_id) do update set role='admin';
commit;
