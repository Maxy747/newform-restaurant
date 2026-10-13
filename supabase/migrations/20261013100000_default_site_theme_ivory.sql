begin;
-- Ivory becomes the default website theme (new installs) and the current choice.
alter table public.checkout_settings alter column site_theme set default 'ivory';
update public.checkout_settings set site_theme = 'ivory' where id;
commit;
