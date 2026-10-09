begin;
-- Delivery pricing: Rs20 per road km on the exact distance (rounded up to the next rupee),
-- still limited to 6 km by road. Replaces the flat Rs100 policy. Safe to re-run.
create or replace function public.delivery_fee_for(p_metres numeric) returns numeric
language sql immutable set search_path = '' as $$ select ceil(p_metres / 50.0) $$;

-- Quotes: the flat-Rs100 check is replaced by the per-km formula (new rows only, history kept).
alter table public.delivery_quotes drop constraint if exists quotes_delivery_flat100;
do $$
begin
 if not exists (select 1 from pg_constraint where conname = 'quotes_delivery_per_km') then
  alter table public.delivery_quotes add constraint quotes_delivery_per_km
   check (fee = public.delivery_fee_for(distance_m)) not valid;
 end if;
end $$;

-- Unused quotes priced under the old flat fee must not be redeemed.
update public.delivery_quotes set expires_at = now()
 where order_id is null and expires_at > now() and fee <> public.delivery_fee_for(distance_m);

-- Orders: same rule for new orders and pricing changes; untouched historical rows stay valid.
create or replace function public.check_delivery_policy() returns trigger language plpgsql set search_path = public as $$
begin
 if new.order_type = 'delivery' and new.delivery_distance_m is not null then
  if TG_OP = 'UPDATE' then
   if new.delivery_distance_m is not distinct from old.delivery_distance_m and new.delivery_fee is not distinct from old.delivery_fee then return new; end if;
  end if;
  if new.delivery_distance_m > 6000 or new.delivery_fee <> public.delivery_fee_for(new.delivery_distance_m) then
   raise exception 'Delivery is Rs20 per km within 6 km by road';
  end if;
 end if;
 return new;
end $$;
commit;
