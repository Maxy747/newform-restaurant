begin;
-- Website theme every visitor sees (staff keep their own toggle). Set by admins through oms-api.
alter table public.checkout_settings add column if not exists site_theme text not null default 'light';
alter table public.checkout_settings drop constraint if exists checkout_settings_site_theme_check;
alter table public.checkout_settings add constraint checkout_settings_site_theme_check check (site_theme in ('light','ivory','dark'));

-- Website gallery. Rows are public; only admins add, re-caption or delete them.
-- image_url/thumb_url are either a Supabase Storage public URL (admin uploads, listed in
-- storage_paths so they can be removed) or a site-relative path for the bundled photos.
create table public.gallery_photos (
 id uuid primary key default gen_random_uuid(),
 image_url text not null check (image_url ~ '^(https://[^\s"''<>]+|gallery/[a-z0-9-]+\.webp)$'),
 thumb_url text not null check (thumb_url ~ '^(https://[^\s"''<>]+|gallery/[a-z0-9-]+\.webp)$'),
 storage_paths text[] not null default '{}' check (cardinality(storage_paths) <= 4),
 caption text not null default '' check (length(caption) <= 80),
 width integer check (width between 1 and 10000),
 height integer check (height between 1 and 10000),
 sort_order integer not null default 0,
 created_at timestamptz not null default now()
);
create index gallery_photos_order on public.gallery_photos (sort_order, created_at);
alter table public.gallery_photos enable row level security;
revoke all on public.gallery_photos from anon, authenticated;
grant select on public.gallery_photos to anon, authenticated;
grant insert, delete on public.gallery_photos to authenticated;
grant update (caption, sort_order) on public.gallery_photos to authenticated;
grant all on public.gallery_photos to service_role;
create policy "Public reads gallery" on public.gallery_photos for select to anon, authenticated using (true);
create policy "Admins add gallery photos" on public.gallery_photos for insert to authenticated
 with check (exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'admin'));
create policy "Admins edit gallery photos" on public.gallery_photos for update to authenticated
 using (exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'admin'))
 with check (exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'admin'));
create policy "Admins delete gallery photos" on public.gallery_photos for delete to authenticated
 using (exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'admin'));

-- The six launch photos ship with the site (public/gallery); admins can delete them like any other.
insert into public.gallery_photos (image_url, thumb_url, caption, width, height, sort_order) values
 ('gallery/exterior-aerial-dusk-full.webp', 'gallery/exterior-aerial-dusk-800.webp', 'Newform at dusk, from above', 1536, 1024, 0),
 ('gallery/exterior-front-day-full.webp', 'gallery/exterior-front-day-800.webp', 'The front entrance', 1536, 1024, 1),
 ('gallery/dining-terrace-full.webp', 'gallery/dining-terrace-800.webp', 'The terrace dining hall', 1600, 900, 2),
 ('gallery/exterior-front-dusk-full.webp', 'gallery/exterior-front-dusk-800.webp', 'Lights on at sunset', 1536, 1024, 3),
 ('gallery/dining-terrace-garden-full.webp', 'gallery/dining-terrace-garden-800.webp', 'Tables beside the greenery', 1536, 1024, 4),
 ('gallery/exterior-street-dusk-full.webp', 'gallery/exterior-street-dusk-800.webp', 'On Main Road, Kalpetta', 1600, 900, 5);

-- Uploaded photos: public to read, admin-only to write (same rule as menu images).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('gallery-photos', 'gallery-photos', true, 8388608, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update set public = true, file_size_limit = 8388608, allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists "Public can view gallery photos" on storage.objects;
drop policy if exists "Admins manage gallery photos" on storage.objects;
create policy "Public can view gallery photos" on storage.objects for select to public using (bucket_id = 'gallery-photos');
create policy "Admins manage gallery photos" on storage.objects for all to authenticated
 using (bucket_id = 'gallery-photos' and exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'admin'))
 with check (bucket_id = 'gallery-photos' and exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'admin'));
commit;
