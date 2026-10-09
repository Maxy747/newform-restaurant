begin;
-- End-of-day cash count: what the drawer should hold for an India business day (from recorded payments)
-- versus what staff counted. Counts are permanent snapshots; recount by saving another one. Safe to re-run.

create table if not exists public.cash_counts (
 id uuid primary key default gen_random_uuid(),
 business_day date not null,
 counted_at timestamptz not null default now(),
 counted_by uuid references auth.users(id) on delete set null,
 opening_float numeric(12,2) not null check(opening_float between 0 and 1000000),
 counted numeric(12,2) not null check(counted between 0 and 10000000),
 expected numeric(12,2) not null,
 difference numeric(12,2) not null,
 denominations jsonb,
 summary jsonb not null,
 note text check(note is null or char_length(note)<=300),
 constraint cash_count_balances check(difference=counted-expected)
);
create index if not exists cash_counts_day_idx on public.cash_counts(business_day,counted_at desc);
alter table public.cash_counts enable row level security;
revoke all on public.cash_counts from public,anon,authenticated,service_role;
grant select on public.cash_counts to service_role;

create or replace function public.cash_counts_immutable() returns trigger
language plpgsql set search_path='' as $$
begin
 raise exception 'Saved cash counts cannot be changed or deleted. Save a new count instead.';
end $$;
drop trigger if exists cash_counts_immutable on public.cash_counts;
create trigger cash_counts_immutable before update or delete on public.cash_counts
 for each row execute function public.cash_counts_immutable();

-- Money recorded on a business day, by when it was received (payment events), not when ordered.
-- Cash: counter cash sales, pay-at-counter orders marked paid by staff, and cash drivers collected.
-- Refunds: paid orders cancelled that day, by how they were paid. Razorpay never touches the drawer.
create or replace function public.oms_cash_summary(p_day date) returns jsonb
language sql stable security invoker set search_path='' as $$
 with bounds as (select (p_day::timestamp at time zone 'Asia/Kolkata') s,((p_day+1)::timestamp at time zone 'Asia/Kolkata') e),
 paid as (
  select o.id,o.total,ev.created_at,
   case when ev.detail='Paid at counter (UPI)' then 'upi' else 'cash' end as how,
   case when ev.detail like 'Paid at counter%' then 'counter'
    when exists(select 1 from public.delivery_drivers d where d.user_id=ev.actor_id) then 'driver' else 'staff' end as via
  from public.order_events ev join public.orders o on o.id=ev.order_id
  where ev.event_type='payment.updated' and ev.detail in ('Cash payment received','Paid at counter (cash)','Paid at counter (UPI)')),
 today as (select paid.* from paid,bounds where paid.created_at>=bounds.s and paid.created_at<bounds.e),
 refunds as (
  select distinct on (o.id) o.id,o.total,p.how
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

-- Saves a count for one of the last 7 India days. With denominations, the server adds them up itself.
create or replace function public.oms_cash_count(p_actor uuid,p_day date,p_opening numeric,p_counted numeric,p_denominations jsonb,p_note text) returns uuid
language plpgsql security invoker set search_path='' as $$
declare today date=(now() at time zone 'Asia/Kolkata')::date; s jsonb; total numeric=0; k text; v jsonb; note text=nullif(btrim(coalesce(p_note,'')),''); cid uuid; expected numeric;
begin
 if public.oms_actor_role(p_actor) is null or public.oms_actor_role(p_actor) not in ('admin','staff') then raise exception 'Manager access required'; end if;
 if p_day is null or p_day>today or p_day<today-7 then raise exception 'Choose today or one of the last 7 days'; end if;
 if p_opening is null or p_opening<0 or p_opening>1000000 or p_opening<>round(p_opening,2) then raise exception 'Enter the opening float in rupees'; end if;
 if p_denominations is not null then
  if jsonb_typeof(p_denominations)<>'object' then raise exception 'Invalid note and coin counts'; end if;
  for k,v in select * from jsonb_each(p_denominations) loop
   if k not in ('500','200','100','50','20','10','5','2','1') or jsonb_typeof(v)<>'number' or (v#>>'{}')::numeric<0 or (v#>>'{}')::numeric>100000 or (v#>>'{}')::numeric<>trunc((v#>>'{}')::numeric) then
    raise exception 'Invalid count for ₹%', k;
   end if;
   total=total+k::numeric*(v#>>'{}')::numeric;
  end loop;
  p_counted=total;
 end if;
 if p_counted is null or p_counted<0 or p_counted>10000000 or p_counted<>round(p_counted,2) then raise exception 'Enter the cash counted in rupees'; end if;
 if note is not null and char_length(note)>300 then raise exception 'Keep the note under 300 characters'; end if;
 s=public.oms_cash_summary(p_day);
 expected=p_opening+(s->>'expected_cash')::numeric;
 insert into public.cash_counts(business_day,counted_by,opening_float,counted,expected,difference,denominations,summary,note)
 values(p_day,p_actor,p_opening,p_counted,expected,p_counted-expected,p_denominations,s,note) returning id into cid;
 return cid;
end $$;

revoke all on function public.cash_counts_immutable(),public.oms_cash_summary(date),
 public.oms_cash_count(uuid,date,numeric,numeric,jsonb,text) from public,anon,authenticated;
grant execute on function public.oms_cash_summary(date),public.oms_cash_count(uuid,date,numeric,numeric,jsonb,text) to service_role;
grant insert on public.cash_counts to service_role; -- oms_cash_count runs as the API role
commit;
