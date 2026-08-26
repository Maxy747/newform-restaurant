-- Run this once in Supabase SQL Editor before deploying the static site.
-- Create the first Auth user in Authentication > Users, then promote it using
-- the UPDATE statement at the bottom of this file.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'staff' check (role in ('staff', 'admin')),
  created_at timestamptz not null default now()
);

create table if not exists public.menu_items (
  id text primary key,
  name text not null,
  category text not null,
  diet text not null check (diet in ('veg', 'non-veg')),
  tag text,
  description text,
  image text,
  "portionType" text not null check ("portionType" in ('single', 'multi')),
  price numeric,
  "pricesJSON" jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint menu_item_pricing check (("portionType" = 'single' and price is not null) or ("portionType" = 'multi' and "pricesJSON" is not null))
);
alter table public.menu_items add column if not exists updated_at timestamptz not null default now();

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
drop trigger if exists menu_items_set_updated_at on public.menu_items;
create trigger menu_items_set_updated_at before update on public.menu_items for each row execute procedure public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.menu_items enable row level security;
grant select on public.menu_items to anon, authenticated;
grant insert, update, delete on public.menu_items to authenticated;
grant select on public.profiles to authenticated;
drop policy if exists "Users can read their own role" on public.profiles;
create policy "Users can read their own role" on public.profiles
for select to authenticated using (id = (select auth.uid()));
drop policy if exists "Anyone can view menu items" on public.menu_items;
drop policy if exists "Authenticated users can insert menu items" on public.menu_items;
drop policy if exists "Authenticated users can update menu items" on public.menu_items;
drop policy if exists "Authenticated users can delete menu items" on public.menu_items;
drop policy if exists "Public can read menu items" on public.menu_items;
drop policy if exists "Admins manage menu items" on public.menu_items;
create policy "Public can read menu items" on public.menu_items for select to anon, authenticated using (true);
create policy "Admins manage menu items" on public.menu_items for all to authenticated
using (exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'admin'))
with check (exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'admin'));

-- Images are public for visitors, while writes require the admin role.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('menu-images', 'menu-images', true, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do update set public = true, file_size_limit = 5242880, allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists "Public can view menu images" on storage.objects;
drop policy if exists "Admins manage menu images" on storage.objects;
create policy "Public can view menu images" on storage.objects for select to public using (bucket_id = 'menu-images');
create policy "Admins manage menu images" on storage.objects for all to authenticated
using (bucket_id = 'menu-images' and exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'admin'))
with check (bucket_id = 'menu-images' and exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'admin'));

-- After creating an Auth user, replace this email and run once:
-- insert into public.profiles (id, role)
-- select id, 'admin' from auth.users where email = 'admin@example.com'
-- on conflict (id) do update set role = 'admin';
