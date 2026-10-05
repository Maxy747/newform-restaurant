begin;
-- Invalidate unconsumed quotes issued under the previous delivery policy.
update public.delivery_quotes set expires_at=now() where order_id is null and expires_at>now() and distance_m<=40000;
alter table public.delivery_quotes add constraint quotes_delivery_6km check(distance_m<=6000) not valid;
alter table public.delivery_quotes add constraint quotes_delivery_flat100 check(fee=100) not valid;
-- Historical orders must still be updatable; validate only new orders/pricing changes.
create or replace function public.check_delivery_policy() returns trigger language plpgsql set search_path=public as $$
begin
 if new.order_type='delivery' and new.delivery_distance_m is not null then
  if TG_OP='UPDATE' then
   if new.delivery_distance_m is not distinct from old.delivery_distance_m and new.delivery_fee is not distinct from old.delivery_fee then return new; end if;
  end if;
  if new.delivery_distance_m>6000 or new.delivery_fee<>100 then raise exception 'Delivery requires a flat Rs100 fee within 6km by road'; end if;
 end if;
 return new;
end $$;
create trigger orders_delivery_policy before insert or update on public.orders for each row execute function public.check_delivery_policy();
commit;
