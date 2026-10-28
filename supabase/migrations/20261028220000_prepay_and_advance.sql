begin;
-- Pay before confirming (Settings → Payments). When on, website orders are paid by UPI (staff
-- confirm the money arrived) or online (Razorpay, confirmed automatically) before they reach the
-- kitchen: COD, pay at counter and WhatsApp are off. With partial payment also on, the customer
-- may instead pay an advance (advance_percent of the total, rounded up to the rupee) and the rest
-- on delivery (COD rules apply) or at the counter. Counter billing is unaffected.
alter table public.checkout_settings add column if not exists prepay_required boolean not null default false;
alter table public.checkout_settings add column if not exists partial_payment boolean not null default false;
alter table public.checkout_settings add column if not exists advance_percent integer not null default 50;
alter table public.checkout_settings add column if not exists upi_id text;
alter table public.checkout_settings add column if not exists upi_name text;
alter table public.checkout_settings drop constraint if exists checkout_settings_advance_percent_check;
alter table public.checkout_settings add constraint checkout_settings_advance_percent_check check (advance_percent between 10 and 90);
alter table public.checkout_settings drop constraint if exists checkout_settings_upi_id_check;
alter table public.checkout_settings add constraint checkout_settings_upi_id_check check (upi_id is null or upi_id ~ '^[A-Za-z0-9._-]{2,64}@[A-Za-z0-9.-]{2,64}$');
alter table public.checkout_settings drop constraint if exists checkout_settings_upi_name_check;
alter table public.checkout_settings add constraint checkout_settings_upi_name_check check (upi_name is null or length(upi_name) between 1 and 60);

-- advance_due: what must be paid before the order is confirmed (the whole total, or the advance);
-- advance_paid: what has been received that way; advance_method: how ('upi' or 'razorpay').
-- payment_method stays the method for the rest: 'upi'/'razorpay' when paid in full up front,
-- 'cod'/'cash' when only an advance was paid.
alter table public.orders add column if not exists advance_due numeric(10,2);
alter table public.orders add column if not exists advance_paid numeric(10,2) not null default 0;
alter table public.orders add column if not exists advance_method text;
alter table public.orders drop constraint if exists orders_advance_method_check;
alter table public.orders add constraint orders_advance_method_check check (advance_method is null or advance_method in ('upi','razorpay'));
alter table public.orders drop constraint if exists orders_advance_amounts_check;
alter table public.orders add constraint orders_advance_amounts_check check (advance_paid >= 0 and (advance_due is null or (advance_due > 0 and advance_paid <= advance_due)));

-- Website orders (oms-api create). p_method: 'razorpay' or 'upi' to pay up front, otherwise the
-- old methods; p_customer.pay_plan: 'full' (default) or 'advance'.
create or replace function public.oms_create_order(p_user uuid,p_request uuid,p_token_hash text,p_customer jsonb,p_items jsonb,p_method text)
returns uuid language plpgsql security invoker set search_path='' as $$
declare q public.delivery_quotes; oid uuid; existing uuid; s public.checkout_settings; kind text=p_customer->>'order_type';
 plan text=coalesce(nullif(p_customer->>'pay_plan',''),'full'); upfront boolean; base_method text; total numeric; due numeric;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,0));
 select id into existing from public.orders where request_id=p_request;
 if existing is not null then
  return public.oms_create_order_base(p_user,p_request,p_token_hash,p_customer,p_items,case when p_method in ('upi','razorpay') then 'whatsapp' else p_method end);
 end if;
 select * into s from public.checkout_settings where id;
 if plan not in ('full','advance') then raise exception 'Invalid payment plan'; end if;
 upfront = p_method in ('razorpay','upi');
 if coalesce(s.prepay_required,false) then
  if not upfront then raise exception 'Pay by UPI or online to place this order'; end if;
  if plan='advance' and not coalesce(s.partial_payment,false) then raise exception 'Partial payment is not available right now'; end if;
 else
  if p_method='upi' then raise exception 'Invalid payment method'; end if;
  plan='full';
 end if;
 if p_method='upi' and s.upi_id is null then raise exception 'UPI payment is not set up yet. Please contact the restaurant.'; end if;
 -- The base checks run with the method for what's left to pay: COD/counter for an advance,
 -- WhatsApp (no cash rules) for a full UPI payment.
 base_method = case when plan='advance' then case when kind='delivery' then 'cod' else 'cash' end
  when p_method='upi' then 'whatsapp' else p_method end;
 if kind='delivery' then
  select * into q from public.delivery_quotes where id=(p_customer->>'quote_id')::uuid for update;
  if not found or q.expires_at<now() or q.order_id is not null or q.user_id is distinct from p_user then
   raise exception 'Delivery quote expired. Calculate delivery again.';
  end if;
 end if;
 oid=public.oms_create_order_base(p_user,p_request,p_token_hash,p_customer,p_items,base_method);
 if q.id is not null then
  update public.orders set delivery_fee=q.fee,delivery_distance_m=q.distance_m,
   delivery_latitude=q.latitude,delivery_longitude=q.longitude,total=total+q.fee where id=oid;
  update public.payments set amount_paise=amount_paise+round(q.fee*100) where order_id=oid;
  update public.delivery_quotes set order_id=oid where id=q.id;
 end if;
 if upfront and coalesce(s.prepay_required,false) then
  select o.total into total from public.orders o where o.id=oid;
  due = case when plan='advance' then least(total, ceil(total*s.advance_percent/100.0)) else total end;
  update public.orders set advance_due=due, advance_method=p_method, order_status='awaiting_payment',
   payment_method=case when plan='advance' then base_method else p_method end where id=oid;
  -- An online advance gets its own payment row for that amount (a full online payment already has one).
  if p_method='razorpay' and plan='advance' then
   insert into public.payments(order_id,amount_paise) values(oid,round(due*100));
  end if;
  insert into public.order_events(order_id,actor_id,event_type,detail) values(oid,p_user,'payment.requested',
   case when plan='advance' then 'Advance of ₹'||trim_scale(due)||' requested' else 'Payment of ₹'||trim_scale(due)||' requested' end);
 end if;
 return oid;
end $$;
revoke all on function public.oms_create_order(uuid,uuid,text,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.oms_create_order(uuid,uuid,text,jsonb,jsonb,text) to service_role;

-- Razorpay: as before, plus advances. An online advance confirms the order but the order stays
-- unpaid (payment_status pending) until the rest is collected.
create or replace function public.oms_apply_payment(p_event text,p_rz_order text,p_payment text,p_amount bigint,p_currency text,p_status text,p_refunded bigint default 0)
returns void language plpgsql security invoker set search_path='' as $$
declare p public.payments; advance boolean; kept bigint;
begin
 select * into p from public.payments where razorpay_order_id=p_rz_order for update;
 if not found then raise exception 'Payment order not found'; end if;
 if p.amount_paise<>p_amount or p_currency<>'INR' or p_status not in ('paid','failed','refunded') or p_payment is null then raise exception 'Payment mismatch'; end if;
 insert into public.payment_events(event_id,order_id) values(p_event,p.order_id) on conflict do nothing;
 if not found then return; end if;
 if p.status='refunded' or (p.status='paid' and p_status='failed') then return; end if;
 if p.razorpay_payment_id is not null and p.status='paid' and p.razorpay_payment_id<>p_payment then raise exception 'Payment identity mismatch'; end if;
 select payment_method<>'razorpay' into advance from public.orders where id=p.order_id;
 if p_status='refunded' and p_refunded<p.amount_paise then
  update public.payments set status='paid',razorpay_payment_id=p_payment,refunded_paise=greatest(refunded_paise,p_refunded),updated_at=now() where order_id=p.order_id;
 else
  update public.payments set status=p_status,razorpay_payment_id=p_payment,refunded_paise=greatest(refunded_paise,p_refunded),
   failure_reason=case when p_status='failed' then 'Payment failed; you may retry' else null end,updated_at=now() where order_id=p.order_id;
 end if;
 kept = case when p_status='failed' then 0 else greatest(0, p.amount_paise - greatest(p.refunded_paise, p_refunded)) end;
 if advance then
  update public.orders set advance_paid=kept/100.0,
   order_status=case when p_status in ('paid','refunded') and kept>0 and order_status='awaiting_payment' then 'new' else order_status end
  where id=p.order_id;
 elsif p_status='refunded' and p_refunded<p.amount_paise then
  update public.orders set payment_status='paid',advance_paid=case when advance_due is null then advance_paid else kept/100.0 end,
   order_status=case when order_status='awaiting_payment' then 'new' else order_status end where id=p.order_id;
 else
  update public.orders set payment_status=p_status,advance_paid=case when advance_due is null then advance_paid else kept/100.0 end,
   order_status=case when p_status='paid' and order_status='awaiting_payment' then 'new' else order_status end where id=p.order_id;
 end if;
 insert into public.order_events(order_id,event_type,detail) values(p.order_id,'payment.updated',case when advance then 'Advance '||p_status else p_status end);
 update public.order_signals set updated_at=clock_timestamp() where order_id=p.order_id;
end $$;

-- UPI: staff (or admins) confirm the money arrived. The order then goes to the kitchen; a full
-- UPI payment marks it paid, an advance leaves the rest to collect.
create or replace function public.oms_confirm_upi(p_actor uuid,p_order uuid) returns void
language plpgsql security invoker set search_path='' as $$
declare o public.orders; r text=public.oms_actor_role(p_actor);
begin
 if r is null or r not in ('admin','staff') then raise exception 'Staff access required'; end if;
 select * into o from public.orders where id=p_order for update;
 if not found then raise exception 'Order not found'; end if;
 if o.advance_method is distinct from 'upi' or o.order_status<>'awaiting_payment' then raise exception 'This order is not waiting for a UPI payment'; end if;
 update public.orders set advance_paid=o.advance_due, order_status='new',
  payment_status=case when o.payment_method='upi' then 'paid' else payment_status end where id=p_order;
 insert into public.order_events(order_id,actor_id,event_type,detail) values(p_order,p_actor,'payment.updated',
  case when o.payment_method='upi' then 'UPI payment received' else 'UPI advance received' end);
 update public.order_signals set updated_at=clock_timestamp() where order_id=p_order;
end $$;
revoke all on function public.oms_confirm_upi(uuid,uuid) from public,anon,authenticated;
grant execute on function public.oms_confirm_upi(uuid,uuid) to service_role;

-- Cash count: cash collected on an order with an advance is only the rest; UPI paid up front
-- on the website counts with UPI.
create or replace function public.oms_cash_summary(p_day date) returns jsonb
language sql stable security invoker set search_path='' as $$
 with bounds as (select (p_day::timestamp at time zone 'Asia/Kolkata') s,((p_day+1)::timestamp at time zone 'Asia/Kolkata') e),
 paid as (
  select o.id,
   case when ev.detail like 'UPI % received' then o.advance_paid
    when ev.detail='Cash payment received' then o.total-o.advance_paid else o.total end as total,
   ev.created_at,
   case when ev.detail='Paid at counter (UPI)' or ev.detail like 'UPI % received' then 'upi' else 'cash' end as how,
   case when ev.detail like 'Paid at counter%' then 'counter'
    when exists(select 1 from public.delivery_drivers d where d.user_id=ev.actor_id) then 'driver' else 'staff' end as via
  from public.order_events ev join public.orders o on o.id=ev.order_id
  where ev.event_type='payment.updated' and (ev.detail in ('Cash payment received','Paid at counter (cash)','Paid at counter (UPI)') or ev.detail like 'UPI % received')),
 today as (select paid.* from paid,bounds where paid.created_at>=bounds.s and paid.created_at<bounds.e),
 refunds as (
  select distinct on (o.id,p.how) o.id,p.total,p.how
  from public.order_events ev join public.orders o on o.id=ev.order_id join paid p on p.id=o.id,bounds
  where ev.event_type='order.cancelled' and ev.created_at>=bounds.s and ev.created_at<bounds.e and p.created_at<=ev.created_at)
 select jsonb_build_object(
  'day',p_day,
  'counter_cash',(select coalesce(sum(total),0) from today where how='cash' and via='counter'),
  'counter_cash_count',(select count(*) from today where how='cash' and via='counter'),
  'staff_cash',(select coalesce(sum(total),0) from today where how='cash' and via='staff'),
  'staff_cash_count',(select count(*) from today where how='cash' and via='staff'),
  'driver_cash',(select coalesce(sum(total),0) from today where how='cash' and via='driver'),
  'driver_cash_count',(select count(*) from today where how='cash' and via='driver'),
  'cash_refunds',(select coalesce(sum(total),0) from refunds where how='cash'),
  'cash_refund_count',(select count(*) from refunds where how='cash'),
  'expected_cash',(select coalesce(sum(total),0) from today where how='cash')-(select coalesce(sum(total),0) from refunds where how='cash'),
  'upi',(select coalesce(sum(total),0) from today where how='upi'),
  'upi_count',(select count(*) from today where how='upi'),
  'upi_refunds',(select coalesce(sum(total),0) from refunds where how='upi')
 )
$$;
commit;
