begin;
-- Which welcome splash every visitor gets: 'classic' (the splash as it was on 28 Oct 2026) or
-- 'modern' (the remastered one). Set by admins through oms-api (set_splash_style).
alter table public.checkout_settings add column if not exists splash_style text not null default 'classic';
alter table public.checkout_settings drop constraint if exists checkout_settings_splash_style_check;
alter table public.checkout_settings add constraint checkout_settings_splash_style_check check (splash_style in ('classic','modern'));
commit;
