begin;
-- Whether menu cards with a representative stock photo show the "Representative image" tag.
-- Set by admins through oms-api (set_stock_tag).
alter table public.checkout_settings add column if not exists show_stock_tag boolean not null default true;
commit;
