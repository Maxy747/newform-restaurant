begin;
-- Razorpay refunds started from Admin (order drawer → Refund). Each row's id is sent to Razorpay as the refund
-- `receipt`, which Razorpay treats as an idempotency key, so retrying a row can never refund twice.
-- `requested` = sent (or about to be) but not yet confirmed by Razorpay. Safe to re-run.

create table if not exists public.refunds (
 id uuid primary key default gen_random_uuid(),
 order_id uuid not null references public.orders(id) on delete restrict,
 request_id uuid not null unique,
 amount_paise bigint not null check(amount_paise>0),
 reason text not null check(char_length(reason) between 3 and 200),
 status text not null default 'requested' check(status in ('requested','pending','processed','failed')),
 razorpay_refund_id text unique check(razorpay_refund_id is null or razorpay_refund_id ~ '^rfnd_[A-Za-z0-9]+$'),
 failure_reason text check(failure_reason is null or char_length(failure_reason)<=300),
 requested_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index if not exists refunds_order_idx on public.refunds(order_id,created_at);
create index if not exists refunds_requested_by_idx on public.refunds(requested_by);
alter table public.refunds enable row level security;
revoke all on public.refunds from public,anon,authenticated,service_role;
grant select,insert on public.refunds to service_role; -- the RPCs below run as the API role
grant update(status,razorpay_refund_id,failure_reason,updated_at) on public.refunds to service_role;

-- Admin-only claim. Reserves the amount under the payment row lock, so two refunds can't together exceed what was paid.
-- Replaying the same request returns the existing row (the API then finishes it with the same receipt).
create or replace function public.oms_request_refund(p_actor uuid,p_order uuid,p_request uuid,p_amount bigint,p_reason text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare p public.payments; r public.refunds; method text; reserved bigint; remaining bigint; why text=btrim(coalesce(p_reason,''));
begin
 if public.oms_actor_role(p_actor) is distinct from 'admin' then raise exception 'Admin access required'; end if;
 if p_request is null then raise exception 'Invalid refund request'; end if;
 select * into p from public.payments where order_id=p_order for update;
 if not found then raise exception 'Only orders paid online can be refunded here'; end if;
 select * into r from public.refunds where request_id=p_request;
 if found then
  if r.order_id<>p_order or r.amount_paise<>p_amount then raise exception 'This refund request was already used. Reopen the refund form.'; end if;
  return to_jsonb(r)||jsonb_build_object('payment_id',p.razorpay_payment_id);
 end if;
 select payment_method into method from public.orders where id=p_order;
 if method is distinct from 'razorpay' then raise exception 'Only orders paid online can be refunded here'; end if;
 if p.status='refunded' then raise exception 'This payment has already been fully refunded'; end if;
 if p.status<>'paid' or p.razorpay_payment_id is null then raise exception 'Only paid online orders can be refunded'; end if;
 if p_amount is null or p_amount<=0 then raise exception 'Enter the amount to refund'; end if;
 if char_length(why)<3 or char_length(why)>200 then raise exception 'Give a short reason (3 to 200 characters)'; end if;
 -- Refunds made directly in the Razorpay Dashboard only show up in refunded_paise, so use whichever is larger.
 select coalesce(sum(amount_paise),0) into reserved from public.refunds where order_id=p_order and status<>'failed';
 remaining=p.amount_paise-greatest(p.refunded_paise,reserved);
 if remaining<=0 then raise exception 'Nothing is left to refund on this order'; end if;
 if p_amount>remaining then raise exception 'You can refund up to ₹%',to_char(remaining/100.0,'FM9999999990.00'); end if;
 insert into public.refunds(order_id,request_id,amount_paise,reason,requested_by) values(p_order,p_request,p_amount,why,p_actor) returning * into r;
 insert into public.order_events(order_id,actor_id,event_type,detail)
  values(p_order,p_actor,'refund.requested','Refund of ₹'||to_char(p_amount/100.0,'FM9999999990.00')||' requested: '||why);
 update public.order_signals set updated_at=clock_timestamp() where order_id=p_order;
 return to_jsonb(r)||jsonb_build_object('payment_id',p.razorpay_payment_id);
end $$;

-- Records what Razorpay says about a refund. Called by the API (by our id) and the webhook (by Razorpay's id;
-- refunds made in the Razorpay Dashboard have no row and are ignored). processed/failed are final.
create or replace function public.oms_record_refund(p_refund uuid,p_rz_refund text,p_status text,p_failure text) returns void
language plpgsql security invoker set search_path='' as $$
declare r public.refunds;
begin
 if p_status not in ('pending','processed','failed') then raise exception 'Invalid refund status'; end if;
 if p_rz_refund is not null and p_rz_refund !~ '^rfnd_[A-Za-z0-9]+$' then raise exception 'Invalid Razorpay refund'; end if;
 if p_refund is not null then select * into r from public.refunds where id=p_refund for update;
 elsif p_rz_refund is not null then select * into r from public.refunds where razorpay_refund_id=p_rz_refund for update;
 end if;
 if r.id is null then
  if p_refund is not null then raise exception 'Refund not found'; end if;
  return;
 end if;
 if r.razorpay_refund_id is not null and p_rz_refund is not null and r.razorpay_refund_id<>p_rz_refund then raise exception 'Refund identity mismatch'; end if;
 if r.status in ('processed','failed') then return; end if;
 update public.refunds set status=p_status,razorpay_refund_id=coalesce(p_rz_refund,razorpay_refund_id),
  failure_reason=case when p_status='failed' then left(coalesce(nullif(btrim(p_failure),''),'Refund failed'),300) end,updated_at=now() where id=r.id;
 if p_status<>r.status then
  insert into public.order_events(order_id,event_type,detail) values(r.order_id,'refund.'||p_status,
   'Refund of ₹'||to_char(r.amount_paise/100.0,'FM9999999990.00')||' '||case p_status when 'processed' then 'processed' when 'pending' then 'accepted by Razorpay' else 'failed' end);
  update public.order_signals set updated_at=clock_timestamp() where order_id=r.order_id;
 end if;
end $$;

revoke all on function public.oms_request_refund(uuid,uuid,uuid,bigint,text),public.oms_record_refund(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.oms_request_refund(uuid,uuid,uuid,bigint,text),public.oms_record_refund(uuid,text,text,text) to service_role;
commit;
