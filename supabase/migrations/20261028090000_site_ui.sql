begin;
-- Which website UI every visitor gets: 'modern' (the current site) or 'classic' (the frozen
-- pre-overhaul snapshot served under /classic/). Set by admins through oms-api (set_site_ui).
alter table public.checkout_settings add column if not exists site_ui text not null default 'modern';
alter table public.checkout_settings drop constraint if exists checkout_settings_site_ui_check;
alter table public.checkout_settings add constraint checkout_settings_site_ui_check check (site_ui in ('classic','modern'));
commit;
