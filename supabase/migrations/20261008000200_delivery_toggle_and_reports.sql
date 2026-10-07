begin;
-- Admin switch for home delivery (e.g. no delivery staff available). Idempotent.
alter table public.checkout_settings add column if not exists delivery_enabled boolean not null default true;

-- Enforced in the database so no client or API path can create a delivery order while it is off.
create or replace function public.orders_require_delivery_enabled() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if new.order_type='delivery' and not coalesce((select delivery_enabled from public.checkout_settings where id=true),true) then
  raise exception 'Home delivery is currently unavailable. Please choose takeaway or dine in.';
 end if;
 return new;
end $$;
revoke all on function public.orders_require_delivery_enabled() from public,anon,authenticated;
drop trigger if exists orders_require_delivery_enabled on public.orders;
create trigger orders_require_delivery_enabled before insert on public.orders
 for each row execute function public.orders_require_delivery_enabled();

-- Richer reports: same keys as before plus sales, average order and day/hour/type/payment breakdowns (India time).
create or replace function public.oms_analytics(p_start timestamptz,p_end timestamptz) returns jsonb
language sql security invoker set search_path='' as $$
 with o as (select * from public.orders where created_at>=p_start and created_at<p_end),
 live as (select *,(created_at at time zone 'Asia/Kolkata') local_at from o where order_status<>'cancelled')
 select jsonb_build_object(
  'orders',(select count(*) from o),
  'revenue',(select coalesce(sum(total),0) from o where payment_status='paid'),
  'sales',(select coalesce(sum(total),0) from live),
  'avg_order',(select coalesce(round(avg(total),2),0) from live),
  'new',(select count(*) from o where order_status='new'),
  'preparing',(select count(*) from o where order_status='preparing'),
  'ready',(select count(*) from o where order_status='ready'),
  'completed',(select count(*) from o where order_status='completed'),
  'cancelled',(select count(*) from o where order_status='cancelled'),
  'top_items',(select coalesce(jsonb_agg(t),'[]'::jsonb) from (
   select x->>'name' as name,sum((x->>'quantity')::integer) as quantity from live,
   lateral jsonb_array_elements(live.items) x group by x->>'name' order by quantity desc limit 8) t),
  'daily',(select coalesce(jsonb_agg(d order by d.day),'[]'::jsonb) from (
   select local_at::date as day,count(*) as orders,sum(total) as sales from live group by 1) d),
  'hourly',(select coalesce(jsonb_agg(h order by h.hour),'[]'::jsonb) from (
   select extract(hour from local_at)::integer as hour,count(*) as orders,sum(total) as sales from live group by 1) h),
  'by_type',(select coalesce(jsonb_agg(b order by b.orders desc),'[]'::jsonb) from (
   select order_type as key,count(*) as orders,sum(total) as sales from live group by 1) b),
  'by_payment',(select coalesce(jsonb_agg(b order by b.orders desc),'[]'::jsonb) from (
   select payment_method as key,count(*) as orders,sum(total) as sales from live group by 1) b)
 )
$$;
revoke all on function public.oms_analytics(timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.oms_analytics(timestamptz,timestamptz) to service_role;
commit;
