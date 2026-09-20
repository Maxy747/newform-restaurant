-- Additive upgrade of supabase_schema.sql; existing orders and menu stay intact.
begin;
alter function public.set_updated_at() set search_path='';
-- Legacy profiles.role='staff' means customer. Never promote those accounts.
create table public.restaurant_roles (
 user_id uuid primary key references auth.users(id) on delete cascade,
 role text not null check(role in ('staff','kitchen','delivery','admin')),
 created_at timestamptz not null default now()
);
alter table public.restaurant_roles enable row level security;
grant select on public.restaurant_roles to authenticated;
create policy own_restaurant_role on public.restaurant_roles for select to authenticated using(user_id=(select auth.uid()));
grant all on public.restaurant_roles to service_role;
grant select,update on public.menu_items to service_role;
grant select on public.profiles to service_role;
revoke update on public.profiles from authenticated;
grant update(full_name,phone,default_address) on public.profiles to authenticated;
drop policy if exists "Users can update their own customer profile" on public.profiles;
create policy "Users can update their own customer profile" on public.profiles for update to authenticated
using(id=(select auth.uid())) with check(id=(select auth.uid()));
alter table public.menu_items add column if not exists available boolean not null default true;
alter table public.orders add column order_type text not null default 'delivery' check(order_type in ('delivery','takeaway','dine_in'));
alter table public.orders add column table_number text;
alter table public.orders add column request_id uuid unique;
alter table public.orders drop constraint orders_order_status_check;
alter table public.orders add constraint orders_order_status_check check(order_status in ('new','confirmed','preparing','ready','out_for_delivery','completed','cancelled','awaiting_payment'));
alter table public.orders drop constraint orders_payment_status_check;
alter table public.orders add constraint orders_payment_status_check check(payment_status in ('pending','paid','not_required','failed','refunded'));
alter table public.orders drop constraint orders_payment_method_check;
alter table public.orders add constraint orders_payment_method_check check(payment_method in ('whatsapp','cod','cash','razorpay'));
create index orders_created_idx on public.orders(created_at desc);
-- Mutations must pass through the service-only validated API.
revoke insert,update,delete on public.orders from anon,authenticated;
drop policy if exists "Users can create their own orders" on public.orders;
drop policy if exists "Guests can create restaurant orders" on public.orders;
drop policy if exists "Admins manage orders" on public.orders;
grant all on public.orders to service_role;
create table public.order_items (
 id bigint generated always as identity primary key,
 order_id uuid not null references public.orders(id) on delete restrict,
 menu_item_id text references public.menu_items(id) on delete set null,
 name text not null, portion text not null,
 quantity integer not null check(quantity between 1 and 99),
 unit_price numeric(10,2) not null check(unit_price>0)
);
create index order_items_order_idx on public.order_items(order_id);
create index order_items_menu_idx on public.order_items(menu_item_id);
create table public.order_access (
 order_id uuid primary key references public.orders(id) on delete cascade,
 token_hash text not null check(length(token_hash)=64)
);
create table public.payments (
 order_id uuid primary key references public.orders(id) on delete restrict,
 razorpay_order_id text unique, razorpay_payment_id text unique,
 amount_paise bigint not null check(amount_paise>0), currency text not null default 'INR' check(currency='INR'),
 status text not null default 'pending' check(status in ('pending','paid','failed','refunded')),
 failure_reason text, creation_started_at timestamptz, refunded_paise bigint not null default 0 check(refunded_paise>=0),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.payment_events (
 event_id text primary key, order_id uuid not null references public.orders(id) on delete restrict,
 created_at timestamptz not null default now()
);
create index payment_events_order_idx on public.payment_events(order_id);
create table public.order_events (
 id bigint generated always as identity primary key, order_id uuid not null references public.orders(id) on delete restrict,
 actor_id uuid references auth.users(id) on delete set null, event_type text not null, detail text not null,
 created_at timestamptz not null default now()
);
create index order_events_order_idx on public.order_events(order_id,created_at);
create index order_events_actor_idx on public.order_events(actor_id);
create table public.support_tickets (
 id uuid primary key default gen_random_uuid(),order_id uuid not null references public.orders(id) on delete restrict,
 subject text not null check(length(subject) between 3 and 120),
 status text not null default 'open' check(status in ('open','in_progress','resolved')),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create index tickets_order_idx on public.support_tickets(order_id,created_at);
create index tickets_status_idx on public.support_tickets(status,created_at);
create table public.ticket_messages (
 id bigint generated always as identity primary key,ticket_id uuid not null references public.support_tickets(id) on delete restrict,
 author_role text not null check(author_role in ('customer','restaurant')),
 message text not null check(length(message) between 1 and 2000),created_at timestamptz not null default now()
);
create index ticket_messages_ticket_idx on public.ticket_messages(ticket_id,created_at);
-- Live notifications contain IDs only, never customer addresses or access tokens.
create table public.order_signals (
 order_id uuid primary key references public.orders(id) on delete cascade,
 user_id uuid references auth.users(id) on delete set null,updated_at timestamptz not null default now()
);
create index order_signals_user_idx on public.order_signals(user_id);
alter table public.order_signals enable row level security;
grant select on public.order_signals to authenticated;
create policy order_signal_read on public.order_signals for select to authenticated using(
 user_id=(select auth.uid()) or exists(select 1 from public.restaurant_roles where user_id=(select auth.uid()))
 or exists(select 1 from public.profiles where id=(select auth.uid()) and role='admin'));
create table public.oms_rate_limits(bucket text primary key,started_at timestamptz not null default now(),hits integer not null default 1);
do $$ declare t text; begin
 foreach t in array array['order_items','order_access','payments','payment_events','order_events','support_tickets','ticket_messages','oms_rate_limits'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon,authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;
grant all on public.order_signals to service_role;
grant usage,select on sequence public.order_items_id_seq,public.order_events_id_seq,public.ticket_messages_id_seq to service_role;
create function public.oms_rate_limit(p_bucket text,p_limit integer) returns boolean language plpgsql security invoker set search_path='' as $$
declare n integer; begin
 insert into public.oms_rate_limits(bucket) values(p_bucket) on conflict(bucket) do update set
 hits=case when public.oms_rate_limits.started_at<now()-interval '1 minute' then 1 else public.oms_rate_limits.hits+1 end,
 started_at=case when public.oms_rate_limits.started_at<now()-interval '1 minute' then now() else public.oms_rate_limits.started_at end returning hits into n;
 delete from public.oms_rate_limits where started_at<now()-interval '1 day';
 return n<=p_limit;
end $$;
create function public.oms_create_order(p_user uuid,p_request uuid,p_token_hash text,p_customer jsonb,p_items jsonb,p_method text)
returns uuid language plpgsql security invoker set search_path='' as $$
declare oid uuid; existing public.orders; line jsonb; m public.menu_items; prices jsonb;
 snapshot jsonb='[]';qty integer;portion text;unit numeric;subtotal numeric=0;tax numeric;kind text=p_customer->>'order_type';
begin
 if p_request is null or p_token_hash is null or length(p_token_hash)<>64 then raise exception 'Invalid request'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,0));
 select * into existing from public.orders where request_id=p_request;
 if found then
  if existing.user_id is not distinct from p_user and exists(select 1 from public.order_access where order_id=existing.id and token_hash=p_token_hash) then return existing.id; end if;
  raise exception 'Request already used';
 end if;
 if kind is null or kind not in ('delivery','takeaway','dine_in') or p_method is null or p_method not in ('whatsapp','cod','cash','razorpay') then raise exception 'Invalid order type or payment method'; end if;
 if coalesce(length(trim(p_customer->>'name')),0) not between 2 and 100 or coalesce(p_customer->>'phone','') !~ '^\+?[0-9 ()-]{8,20}$' then raise exception 'Enter a valid name and phone'; end if;
 if kind='delivery' and coalesce(length(trim(p_customer->>'address')),0) not between 5 and 500 then raise exception 'Enter a delivery address'; end if;
 if kind='dine_in' and coalesce(length(trim(p_customer->>'table')),0) not between 1 and 20 then raise exception 'Enter a table number'; end if;
 if (kind='delivery' and p_method='cash') or (kind<>'delivery' and p_method='cod') then raise exception 'Choose the correct cash method'; end if;
 if p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 50 then raise exception 'Choose between 1 and 50 items'; end if;
 for line in select * from jsonb_array_elements(p_items) loop
  if coalesce(line->>'quantity','') !~ '^[0-9]{1,2}$' then raise exception 'Invalid quantity'; end if;
  qty=(line->>'quantity')::integer;
  if qty<1 then raise exception 'Invalid quantity'; end if;
  select * into m from public.menu_items where id=line->>'id' and available for share;
  if not found then raise exception 'An item is unavailable. Please refresh your menu'; end if;
  portion=lower(coalesce(nullif(line->>'portion',''),'single'));
  if m."portionType"='multi' then
   if portion not in ('quarter','half','full') then raise exception 'Select a valid portion'; end if;
   prices=m."pricesJSON";
   if jsonb_typeof(prices)='string' then prices=(prices#>>'{}')::jsonb; end if;
   unit=(prices->>portion)::numeric;
  else
   if portion<>'single' then raise exception 'Invalid portion'; end if;
   unit=m.price;
  end if;
  if unit is null or unit<=0 or unit>100000 or unit<>round(unit,2) then raise exception 'Invalid menu price; contact restaurant'; end if;
  subtotal=subtotal+unit*qty;
  snapshot=snapshot||jsonb_build_array(jsonb_build_object('id',m.id,'name',m.name,'portion',portion,'quantity',qty,'price',unit));
 end loop;
 tax=round(subtotal*0.05);
 if subtotal+tax>100000 then raise exception 'Please contact the restaurant for large orders'; end if;
 if p_method='cod' and subtotal+tax<1000 then raise exception 'Cash on delivery requires ₹1,000'; end if;
 insert into public.orders(user_id,request_id,customer_name,phone,delivery_address,table_number,order_type,items,subtotal,tax,total,payment_method,payment_status,order_status)
 values(p_user,p_request,trim(p_customer->>'name'),trim(p_customer->>'phone'),case when kind='delivery' then trim(p_customer->>'address') else '' end,
 case when kind='dine_in' then trim(p_customer->>'table') end,kind,snapshot,subtotal,tax,subtotal+tax,p_method,'pending',case when p_method='razorpay' then 'awaiting_payment' else 'new' end) returning id into oid;
 insert into public.order_access values(oid,p_token_hash);
 insert into public.order_items(order_id,menu_item_id,name,portion,quantity,unit_price)
 select oid,x->>'id',x->>'name',x->>'portion',(x->>'quantity')::integer,(x->>'price')::numeric from jsonb_array_elements(snapshot) x;
 if p_method='razorpay' then insert into public.payments(order_id,amount_paise) values(oid,round((subtotal+tax)*100)); end if;
 insert into public.order_events(order_id,actor_id,event_type,detail) values(oid,p_user,'order.created','Order placed');
 insert into public.order_signals(order_id,user_id) values(oid,p_user);
 return oid;
end $$;
create function public.oms_change_order(p_id uuid,p_actor uuid,p_status text,p_cash boolean default false)
returns void language plpgsql security invoker set search_path='' as $$
declare o public.orders;r text;allowed boolean=false;begin
 select role into r from public.restaurant_roles where user_id=p_actor;
 if exists(select 1 from public.profiles where id=p_actor and role='admin') then r='admin'; end if;
 if r is null then raise exception 'Staff access required'; end if;
 select * into o from public.orders where id=p_id for update;
 if not found then raise exception 'Order not found'; end if;
 if p_cash then
  if r not in ('admin','staff','delivery') or o.payment_method='razorpay' or o.order_status='cancelled' or
   (r='delivery' and (o.order_type<>'delivery' or o.order_status not in ('out_for_delivery','completed'))) then raise exception 'Cannot record this payment'; end if;
  if o.payment_status='paid' then return; end if;
  update public.orders set payment_status='paid' where id=p_id;
  insert into public.order_events(order_id,actor_id,event_type,detail) values(p_id,p_actor,'payment.updated','Cash payment received');
 else
  if p_status=o.order_status then return; end if;
  allowed=case o.order_status when 'new' then p_status='confirmed' when 'confirmed' then p_status='preparing'
   when 'preparing' then p_status='ready' when 'ready' then p_status=case when o.order_type='delivery' then 'out_for_delivery' else 'completed' end
   when 'out_for_delivery' then p_status='completed' else false end;
  if p_status='cancelled' and r in ('admin','staff') and o.order_status not in ('completed','cancelled') then allowed=true; end if;
  if not coalesce(allowed,false) or (r='kitchen' and p_status not in ('confirmed','preparing','ready')) or
   (r='delivery' and (o.order_type<>'delivery' or p_status not in ('out_for_delivery','completed'))) then raise exception 'Invalid order transition'; end if;
  if o.payment_method='razorpay' and o.payment_status<>'paid' and p_status<>'cancelled' then raise exception 'Online payment has not been captured'; end if;
  update public.orders set order_status=p_status where id=p_id;
  insert into public.order_events(order_id,actor_id,event_type,detail) values(p_id,p_actor,'order.'||p_status,p_status);
 end if;
 update public.order_signals set updated_at=clock_timestamp() where order_id=p_id;
end $$;
create function public.oms_apply_payment(p_event text,p_rz_order text,p_payment text,p_amount bigint,p_currency text,p_status text,p_refunded bigint default 0)
returns void language plpgsql security invoker set search_path='' as $$
declare p public.payments;begin
 select * into p from public.payments where razorpay_order_id=p_rz_order for update;
 if not found then raise exception 'Payment order not found'; end if;
 if p.amount_paise<>p_amount or p_currency<>'INR' or p_status not in ('paid','failed','refunded') or p_payment is null then raise exception 'Payment mismatch'; end if;
 insert into public.payment_events(event_id,order_id) values(p_event,p.order_id) on conflict do nothing;
 if not found then return; end if;
 if p.status='refunded' or (p.status='paid' and p_status='failed') then return; end if;
 if p.razorpay_payment_id is not null and p.status='paid' and p.razorpay_payment_id<>p_payment then raise exception 'Payment identity mismatch'; end if;
 if p_status='refunded' and p_refunded<p.amount_paise then
  update public.payments set status='paid',razorpay_payment_id=p_payment,refunded_paise=greatest(refunded_paise,p_refunded),updated_at=now() where order_id=p.order_id;
  update public.orders set payment_status='paid',order_status=case when order_status='awaiting_payment' then 'new' else order_status end where id=p.order_id;
 else
  update public.payments set status=p_status,razorpay_payment_id=p_payment,refunded_paise=greatest(refunded_paise,p_refunded),
   failure_reason=case when p_status='failed' then 'Payment failed; you may retry' else null end,updated_at=now() where order_id=p.order_id;
  update public.orders set payment_status=p_status,order_status=case when p_status='paid' and order_status='awaiting_payment' then 'new' else order_status end where id=p.order_id;
 end if;
 insert into public.order_events(order_id,event_type,detail) values(p.order_id,'payment.updated',p_status);
 update public.order_signals set updated_at=clock_timestamp() where order_id=p.order_id;
end $$;
create function public.oms_ticket(p_order uuid,p_ticket uuid,p_subject text,p_message text,p_staff boolean,p_status text)
returns uuid language plpgsql security invoker set search_path='' as $$
declare tid uuid;begin
 perform 1 from public.orders where id=p_order for update;
 if not found then raise exception 'Order not found'; end if;
 if p_message is null or length(trim(p_message)) not between 1 and 2000 then raise exception 'Write a message (up to 2000 characters)'; end if;
 if p_ticket is null then
  if (select count(*) from public.support_tickets where order_id=p_order and status<>'resolved')>=3 then raise exception 'Please reply to your existing ticket'; end if;
  insert into public.support_tickets(order_id,subject) values(p_order,trim(p_subject)) returning id into tid;
 else
  select id into tid from public.support_tickets where id=p_ticket and order_id=p_order for update;
  if tid is null then raise exception 'Ticket not found'; end if;
  update public.support_tickets set status=case when p_staff then coalesce(p_status,status) else 'open' end,updated_at=now() where id=tid;
 end if;
 insert into public.ticket_messages(ticket_id,author_role,message) values(tid,case when p_staff then 'restaurant' else 'customer' end,trim(p_message));
 update public.order_signals set updated_at=clock_timestamp() where order_id=p_order;
 return tid;
end $$;
-- SECURITY INVOKER and service_role-only: the browser cannot spoof actor IDs.
revoke all on function public.oms_rate_limit(text,integer),public.oms_create_order(uuid,uuid,text,jsonb,jsonb,text),
 public.oms_change_order(uuid,uuid,text,boolean),public.oms_apply_payment(text,text,text,bigint,text,text,bigint),
 public.oms_ticket(uuid,uuid,text,text,boolean,text) from public,anon,authenticated;
grant execute on function public.oms_rate_limit(text,integer),public.oms_create_order(uuid,uuid,text,jsonb,jsonb,text),
 public.oms_change_order(uuid,uuid,text,boolean),public.oms_apply_payment(text,text,text,bigint,text,text,bigint),
 public.oms_ticket(uuid,uuid,text,text,boolean,text) to service_role;
insert into public.order_signals(order_id,user_id) select id,user_id from public.orders on conflict do nothing;
do $$ begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') then alter publication supabase_realtime add table public.order_signals; end if;
end $$;
create function public.oms_analytics(p_start timestamptz,p_end timestamptz) returns jsonb
language sql security invoker set search_path='' as $$
 select jsonb_build_object('orders',count(*),'revenue',coalesce(sum(total) filter(where payment_status='paid'),0),
 'new',count(*) filter(where order_status='new'),'preparing',count(*) filter(where order_status='preparing'),
 'ready',count(*) filter(where order_status='ready'),'completed',count(*) filter(where order_status='completed'),
 'cancelled',count(*) filter(where order_status='cancelled'),
 'top_items',(select coalesce(jsonb_agg(t),'[]'::jsonb) from (
 select x->>'name' as name,sum((x->>'quantity')::integer) as quantity from public.orders o,
 lateral jsonb_array_elements(o.items) x where o.created_at>=p_start and o.created_at<p_end and o.order_status<>'cancelled'
 group by x->>'name' order by quantity desc limit 5) t))
 from public.orders where created_at>=p_start and created_at<p_end
$$;
revoke all on function public.oms_analytics(timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.oms_analytics(timestamptz,timestamptz) to service_role;
commit;
