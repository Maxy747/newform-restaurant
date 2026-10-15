begin;
-- Admin control over online ordering: 'auto' follows opening hours (11 am - 11 pm India time,
-- enforced by oms-api), 'open' / 'closed' override it (late nights, holidays). Safe to re-run.
alter table public.checkout_settings add column if not exists ordering_mode text not null default 'auto';
alter table public.checkout_settings drop constraint if exists checkout_settings_ordering_mode_check;
alter table public.checkout_settings add constraint checkout_settings_ordering_mode_check check (ordering_mode in ('auto', 'open', 'closed'));
commit;
