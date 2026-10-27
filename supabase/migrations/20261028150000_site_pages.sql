begin;
-- How the website is laid out: 'single' (one long scrolling page) or 'multi' (Home, Menu,
-- Gallery, About and Contact as separate pages with a fade between them).
-- Set by admins through oms-api (set_site_pages).
alter table public.checkout_settings add column if not exists site_pages text not null default 'single';
alter table public.checkout_settings drop constraint if exists checkout_settings_site_pages_check;
alter table public.checkout_settings add constraint checkout_settings_site_pages_check check (site_pages in ('single','multi'));
commit;
