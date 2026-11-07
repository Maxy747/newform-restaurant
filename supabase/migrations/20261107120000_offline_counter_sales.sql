begin;
-- Offline counter sales: the admin console can ring up a sale with no internet and send it later.
-- oms_counter_order_at records such a sale at the time it was actually paid (not when it synced),
-- so its daily order number, reports and the end-of-day cash count land on the right day.
-- Safe to re-run. Requires 20261008080000_daily_order_numbers and 20261009150000_counter_billing.

-- Daily numbering honours a sale time handed over for this transaction only (see below).
create or replace function public.orders_assign_daily_number() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare sold text = current_setting('newform.sold_at', true);
begin
 if sold is not null and sold <> '' then new.created_at := sold::timestamptz; end if;
 new.order_day := (coalesce(new.created_at, now()) at time zone 'Asia/Kolkata')::date;
 insert into public.order_day_counters(day, last_number) values (new.order_day, 1)
 on conflict (day) do update set last_number = public.order_day_counters.last_number + 1
 returning last_number into new.daily_number;
 return new;
end $$;

-- A sale time from the device is trusted for up to 24 hours back (5 minutes of clock drift
-- forward); anything else is recorded at the time it reaches the server.
create or replace function public.oms_counter_order_at(p_actor uuid,p_request uuid,p_customer jsonb,p_items jsonb,p_method text,p_sold_at timestamptz) returns uuid
language plpgsql security invoker set search_path='' as $$
declare sold timestamptz = case when p_sold_at is null or p_sold_at > now() + interval '5 minutes' or p_sold_at < now() - interval '24 hours' then null else least(p_sold_at, now()) end;
 existed boolean; oid uuid;
begin
 existed = p_request is not null and exists(select 1 from public.orders where request_id = p_request);
 if sold is not null and not existed then perform set_config('newform.sold_at', sold::text, true); end if;
 oid = public.oms_counter_order(p_actor, p_request, p_customer, p_items, p_method);
 perform set_config('newform.sold_at', '', true);
 -- A replay of an already-saved sale changes nothing.
 if sold is not null and not existed then
  update public.order_events set created_at = sold where order_id = oid;
 end if;
 return oid;
end $$;

revoke all on function public.orders_assign_daily_number(),public.oms_counter_order_at(uuid,uuid,jsonb,jsonb,text,timestamptz) from public,anon,authenticated;
grant execute on function public.oms_counter_order_at(uuid,uuid,jsonb,jsonb,text,timestamptz) to service_role;
commit;
