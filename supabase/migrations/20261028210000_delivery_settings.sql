begin;
-- Delivery range and price are admin settings (Settings → Delivery range and price) instead of
-- the fixed 6 km / Rs20 per km. The fee stays: exact road distance x price per km, rounded up
-- to the rupee. oms-api expires unused quotes whenever these change, so every live quote and
-- new order matches the current settings.
alter table public.checkout_settings add column if not exists delivery_max_km numeric(4,1) not null default 6;
alter table public.checkout_settings add column if not exists delivery_fee_per_km numeric(6,2) not null default 20;
alter table public.checkout_settings drop constraint if exists checkout_settings_delivery_max_km_check;
alter table public.checkout_settings add constraint checkout_settings_delivery_max_km_check check (delivery_max_km between 0.5 and 30);
alter table public.checkout_settings drop constraint if exists checkout_settings_delivery_fee_per_km_check;
alter table public.checkout_settings add constraint checkout_settings_delivery_fee_per_km_check check (delivery_fee_per_km between 0 and 500);

-- The quote checks used fixed numbers; they move into a trigger that reads the settings.
-- (Like the old NOT VALID checks, they apply to new quotes only, so history is untouched.)
alter table public.delivery_quotes drop constraint if exists quotes_delivery_per_km;
alter table public.delivery_quotes drop constraint if exists quotes_delivery_6km;

create or replace function public.delivery_fee_for(p_metres numeric) returns numeric
language sql stable security definer set search_path = '' as $$
 select ceil(p_metres * coalesce((select delivery_fee_per_km from public.checkout_settings where id), 20) / 1000.0)
$$;
create or replace function public.delivery_max_m() returns numeric
language sql stable security definer set search_path = '' as $$
 select coalesce((select delivery_max_km from public.checkout_settings where id), 6) * 1000
$$;

create or replace function public.check_delivery_quote() returns trigger language plpgsql set search_path = '' as $$
begin
 if new.distance_m > public.delivery_max_m() then
  raise exception 'Delivery is available within % km by road', trim_scale(public.delivery_max_m() / 1000);
 end if;
 if new.fee <> public.delivery_fee_for(new.distance_m) then
  raise exception 'Delivery quote does not match the current delivery price';
 end if;
 return new;
end $$;
drop trigger if exists delivery_quote_policy on public.delivery_quotes;
create trigger delivery_quote_policy before insert on public.delivery_quotes for each row execute function public.check_delivery_quote();

-- Orders: same rule for new orders and pricing changes; untouched historical rows stay valid.
create or replace function public.check_delivery_policy() returns trigger language plpgsql set search_path = public as $$
begin
 if new.order_type = 'delivery' and new.delivery_distance_m is not null then
  if TG_OP = 'UPDATE' then
   if new.delivery_distance_m is not distinct from old.delivery_distance_m and new.delivery_fee is not distinct from old.delivery_fee then return new; end if;
  end if;
  if new.delivery_distance_m > public.delivery_max_m() or new.delivery_fee <> public.delivery_fee_for(new.delivery_distance_m) then
   raise exception 'Delivery is Rs% per km within % km by road',
    trim_scale(coalesce((select delivery_fee_per_km from public.checkout_settings where id), 20)), trim_scale(public.delivery_max_m() / 1000);
  end if;
 end if;
 return new;
end $$;
commit;
