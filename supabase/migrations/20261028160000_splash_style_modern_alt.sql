begin;
-- Third welcome splash: 'modern-alt' (dark stage, serif wordmark, lined tagline).
alter table public.checkout_settings drop constraint if exists checkout_settings_splash_style_check;
alter table public.checkout_settings add constraint checkout_settings_splash_style_check check (splash_style in ('classic','modern','modern-alt'));
commit;
