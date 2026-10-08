begin;
-- Delivery drivers: admin-managed roster, shifts, per-order assignment and driver self-claim. Idempotent.
-- All writes go through service-only RPCs called by oms-api; the browser never touches these tables.
create table if not exists public.delivery_drivers (
 user_id uuid primary key references auth.users(id) on delete cascade,
 email text,
 display_name text not null check(length(trim(display_name)) between 1 and 60),
 phone text check(phone is null or phone ~ '^\+?[0-9 ()-]{8,20}$'),
 active boolean not null default true,
 on_shift boolean not null default false,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
alter table public.delivery_drivers enable row level security;
revoke all on public.delivery_drivers from public,anon,authenticated;
grant all on public.delivery_drivers to service_role;

-- Existing delivery employees become active drivers (off shift until they start one).
insert into public.delivery_drivers(user_id,email,display_name)
select r.user_id,u.email,left(coalesce(nullif(trim(p.full_name),''),nullif(split_part(u.email,'@',1),''),'Driver'),60)
from public.restaurant_roles r join auth.users u on u.id=r.user_id left join public.profiles p on p.id=r.user_id
where r.role='delivery'
on conflict(user_id) do nothing;

alter table public.orders add column if not exists assigned_driver uuid references public.delivery_drivers(user_id) on delete set null;
alter table public.orders add column if not exists assigned_at timestamptz;
create index if not exists orders_assigned_driver_idx on public.orders(assigned_driver,order_status);

create or replace function public.oms_actor_role(p_actor uuid) returns text
language sql stable security invoker set search_path='' as $$
 select case when exists(select 1 from public.profiles where id=p_actor and role='admin') then 'admin'
  else (select role from public.restaurant_roles where user_id=p_actor) end
$$;

-- auth.users is not readable by service_role on every project, so this one lookup runs as the migration owner.
create or replace function public.oms_user_id_by_email(p_email text) returns uuid
language sql stable security definer set search_path='' as $$
 select id from auth.users where lower(email)=lower(trim(p_email)) limit 1
$$;

create or replace function public.oms_save_driver(p_actor uuid,p_driver uuid,p_email text,p_name text,p_phone text)
returns uuid language plpgsql security invoker set search_path='' as $$
declare uid uuid; v_name text=trim(coalesce(p_name,'')); v_phone text=nullif(trim(coalesce(p_phone,'')),''); v_email text;
begin
 if public.oms_actor_role(p_actor) is distinct from 'admin' then raise exception 'Admin access required'; end if;
 if length(v_name) not between 1 and 60 then raise exception 'Enter the driver''s name (up to 60 characters)'; end if;
 if v_phone is not null and v_phone !~ '^\+?[0-9 ()-]{8,20}$' then raise exception 'Enter a valid phone number'; end if;
 if p_driver is null then
  if coalesce(trim(p_email),'') !~ '^[^@\s]+@[^@\s]+$' then raise exception 'Enter the email the driver signed up with'; end if;
  uid=public.oms_user_id_by_email(p_email);
  if uid is null then raise exception 'No account uses that email. Ask the driver to sign up on the website first, then add them here.'; end if;
  if public.oms_actor_role(uid) is not null and public.oms_actor_role(uid)<>'delivery' then raise exception 'That account already has restaurant staff access'; end if;
  v_email=lower(trim(p_email));
  insert into public.restaurant_roles(user_id,role) values(uid,'delivery') on conflict(user_id) do nothing;
  insert into public.delivery_drivers(user_id,email,display_name,phone) values(uid,v_email,v_name,v_phone)
  on conflict(user_id) do update set email=excluded.email,display_name=excluded.display_name,phone=excluded.phone,active=true,updated_at=now();
 else
  update public.delivery_drivers set display_name=v_name,phone=v_phone,updated_at=now() where user_id=p_driver returning user_id into uid;
  if uid is null then raise exception 'Driver not found'; end if;
 end if;
 return uid;
end $$;

-- p_active (admin only) enables/disables access; p_on_shift may be set by admin/staff, or by a driver for themselves.
create or replace function public.oms_set_driver_status(p_actor uuid,p_driver uuid,p_active boolean,p_on_shift boolean)
returns void language plpgsql security invoker set search_path='' as $$
declare r text=public.oms_actor_role(p_actor); d public.delivery_drivers; busy integer;
begin
 select * into d from public.delivery_drivers where user_id=p_driver for update;
 if not found then raise exception 'Driver not found'; end if;
 if p_active is not null and p_active<>d.active then
  if r is distinct from 'admin' then raise exception 'Admin access required'; end if;
  if not p_active then
   select count(*) into busy from public.orders where assigned_driver=p_driver and order_status not in ('completed','cancelled');
   if busy>0 then raise exception 'Reassign this driver''s % active deliveries first',busy; end if;
   update public.delivery_drivers set active=false,on_shift=false,updated_at=now() where user_id=p_driver;
   delete from public.restaurant_roles where user_id=p_driver and role='delivery';
  else
   if public.oms_actor_role(p_driver) is not null and public.oms_actor_role(p_driver)<>'delivery' then raise exception 'That account now has another restaurant role'; end if;
   insert into public.restaurant_roles(user_id,role) values(p_driver,'delivery') on conflict(user_id) do nothing;
   update public.delivery_drivers set active=true,updated_at=now() where user_id=p_driver;
  end if;
  d.active=p_active;
 end if;
 if p_on_shift is not null and p_on_shift<>d.on_shift then
  if not (r in ('admin','staff') or (r='delivery' and p_driver=p_actor)) then raise exception 'Not allowed to change this shift'; end if;
  if p_on_shift and not d.active then raise exception 'This driver is disabled'; end if;
  update public.delivery_drivers set on_shift=p_on_shift,updated_at=now() where user_id=p_driver;
 end if;
end $$;

-- Admin/staff assign or reassign any open delivery order; a driver can claim an unassigned ready order or hand back their own before leaving.
create or replace function public.oms_assign_driver(p_id uuid,p_actor uuid,p_driver uuid)
returns void language plpgsql security invoker set search_path='' as $$
declare r text=public.oms_actor_role(p_actor); o public.orders; d public.delivery_drivers;
begin
 if r is null or r='kitchen' then raise exception 'Staff access required'; end if;
 select * into o from public.orders where id=p_id for update;
 if not found then raise exception 'Order not found'; end if;
 if o.order_type<>'delivery' then raise exception 'Only delivery orders have a driver'; end if;
 if o.order_status in ('completed','cancelled') then raise exception 'This order is already closed'; end if;
 if o.assigned_driver is not distinct from p_driver then return; end if;
 if r='delivery' then
  select * into d from public.delivery_drivers where user_id=p_actor;
  if not found or not d.active then raise exception 'Your driver account is disabled'; end if;
  if p_driver=p_actor then
   if o.assigned_driver is not null then raise exception 'Another driver already took this order'; end if;
   if o.order_status<>'ready' then raise exception 'You can claim an order once it is ready'; end if;
   if not d.on_shift then raise exception 'Start your shift before claiming orders'; end if;
  elsif p_driver is null then
   if o.assigned_driver is distinct from p_actor then raise exception 'This is not your delivery'; end if;
   if o.order_status<>'ready' then raise exception 'You can only hand back an order before leaving with it'; end if;
  else
   raise exception 'Drivers can only claim orders for themselves';
  end if;
 elsif p_driver is not null then
  select * into d from public.delivery_drivers where user_id=p_driver;
  if not found or not d.active then raise exception 'Choose an active driver'; end if;
  if not d.on_shift then raise exception '% is off shift',d.display_name; end if;
 end if;
 update public.orders set assigned_driver=p_driver,assigned_at=case when p_driver is null then null else now() end where id=p_id;
 insert into public.order_events(order_id,actor_id,event_type,detail) values(p_id,p_actor,
  case when p_driver is null then 'driver.unassigned' else 'driver.assigned' end,
  case when p_driver is null then 'Driver removed' when r='delivery' then d.display_name||' took this delivery' else 'Assigned to '||d.display_name end);
 update public.order_signals set updated_at=clock_timestamp() where order_id=p_id;
end $$;

-- Same lifecycle as before; drivers may only act on deliveries assigned to them.
create or replace function public.oms_change_order(p_id uuid,p_actor uuid,p_status text,p_cash boolean default false)
returns void language plpgsql security invoker set search_path='' as $$
declare o public.orders;r text;allowed boolean=false;begin
 select role into r from public.restaurant_roles where user_id=p_actor;
 if exists(select 1 from public.profiles where id=p_actor and role='admin') then r='admin'; end if;
 if r is null then raise exception 'Staff access required'; end if;
 select * into o from public.orders where id=p_id for update;
 if not found then raise exception 'Order not found'; end if;
 if r='delivery' then
  if not exists(select 1 from public.delivery_drivers where user_id=p_actor and active) then raise exception 'Your driver account is disabled'; end if;
  if o.assigned_driver is distinct from p_actor then raise exception 'Claim this delivery before updating it'; end if;
 end if;
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

-- Roster with live load plus deliveries completed and cash recorded by each driver in the range.
create or replace function public.oms_driver_report(p_start timestamptz,p_end timestamptz) returns jsonb
language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(x order by x.active desc,x.on_shift desc,lower(x.name)),'[]'::jsonb) from (
  select d.user_id as id,d.display_name as name,d.email,d.phone,d.active,d.on_shift,
   (select count(*) from public.orders o where o.assigned_driver=d.user_id and o.order_status in ('ready','out_for_delivery')) as active_orders,
   (select count(*) from public.order_events e join public.orders o on o.id=e.order_id
     where o.assigned_driver=d.user_id and e.event_type='order.completed' and e.created_at>=p_start and e.created_at<p_end) as delivered,
   (select coalesce(sum(o.total),0) from public.order_events e join public.orders o on o.id=e.order_id
     where e.actor_id=d.user_id and e.event_type='payment.updated' and e.detail='Cash payment received' and e.created_at>=p_start and e.created_at<p_end) as cash
  from public.delivery_drivers d) x
$$;

revoke all on function public.oms_actor_role(uuid),public.oms_user_id_by_email(text),
 public.oms_save_driver(uuid,uuid,text,text,text),public.oms_set_driver_status(uuid,uuid,boolean,boolean),
 public.oms_assign_driver(uuid,uuid,uuid),public.oms_change_order(uuid,uuid,text,boolean),
 public.oms_driver_report(timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.oms_actor_role(uuid),public.oms_user_id_by_email(text),
 public.oms_save_driver(uuid,uuid,text,text,text),public.oms_set_driver_status(uuid,uuid,boolean,boolean),
 public.oms_assign_driver(uuid,uuid,uuid),public.oms_change_order(uuid,uuid,text,boolean),
 public.oms_driver_report(timestamptz,timestamptz) to service_role;
commit;
