begin;
create table public.delivery_quotes (
 id uuid primary key default gen_random_uuid(),
 user_id uuid references auth.users(id) on delete set null,
 latitude double precision not null check(latitude between -90 and 90),
 longitude double precision not null check(longitude between -180 and 180),
 distance_m numeric not null check(distance_m>=0),
 fee numeric(12,2) not null check(fee>=0),
 expires_at timestamptz not null default now()+interval '15 minutes',
 order_id uuid references public.orders(id)
);
alter table public.delivery_quotes enable row level security;
revoke all on public.delivery_quotes from anon,authenticated;
grant all on public.delivery_quotes to service_role;
create index delivery_quotes_expiry on public.delivery_quotes(expires_at);
alter table public.orders add column delivery_fee numeric(12,2) not null default 0;
alter table public.orders add column delivery_distance_m numeric;
alter table public.orders add column delivery_latitude double precision;
alter table public.orders add column delivery_longitude double precision;
alter function public.oms_create_order(uuid,uuid,text,jsonb,jsonb,text) rename to oms_create_order_base;
create function public.oms_create_order(p_user uuid,p_request uuid,p_token_hash text,p_customer jsonb,p_items jsonb,p_method text)
returns uuid language plpgsql security invoker set search_path='' as $$
declare q public.delivery_quotes; oid uuid; existing uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,0));
 select id into existing from public.orders where request_id=p_request;
 if existing is not null then
  return public.oms_create_order_base(p_user,p_request,p_token_hash,p_customer,p_items,p_method);
 end if;
 if p_customer->>'order_type'='delivery' then
  select * into q from public.delivery_quotes where id=(p_customer->>'quote_id')::uuid for update;
  if not found or q.expires_at<now() or q.order_id is not null or q.user_id is distinct from p_user then
   raise exception 'Delivery quote expired. Calculate delivery again.';
  end if;
 end if;
 oid=public.oms_create_order_base(p_user,p_request,p_token_hash,p_customer,p_items,p_method);
 if q.id is not null then
  update public.orders set delivery_fee=q.fee,delivery_distance_m=q.distance_m,
   delivery_latitude=q.latitude,delivery_longitude=q.longitude,total=total+q.fee where id=oid;
  update public.payments set amount_paise=amount_paise+round(q.fee*100) where order_id=oid;
  update public.delivery_quotes set order_id=oid where id=q.id;
 end if;
 return oid;
end $$;
revoke all on function public.oms_create_order(uuid,uuid,text,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.oms_create_order(uuid,uuid,text,jsonb,jsonb,text) to service_role;
commit;
