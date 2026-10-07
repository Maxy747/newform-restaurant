begin;
alter table public.orders drop constraint cod_minimum_total;
alter table public.orders add constraint cod_minimum_total check(payment_method<>'cod' or subtotal+tax>=799);
create table public.checkout_settings (
 id boolean primary key default true check(id),
 cod_enabled boolean not null default true
);
insert into public.checkout_settings(id,cod_enabled) values(true,true);
alter table public.checkout_settings enable row level security;
revoke all on public.checkout_settings from public,anon,authenticated;
grant select,update on public.checkout_settings to service_role;

-- Keep the existing price calculation and idempotency checks intact.
do $$
declare definition text;
begin
 select pg_get_functiondef('public.oms_create_order_base(uuid,uuid,text,jsonb,jsonb,text)'::regprocedure) into definition;
 if position('subtotal+tax<1000' in definition)=0 then raise exception 'Expected COD policy not found'; end if;
 definition=replace(definition,
  'if p_method=''cod'' and subtotal+tax<1000 then raise exception ''Cash on delivery requires ₹1,000''; end if;',
  'if p_method=''cod'' then
    if not coalesce((select cod_enabled from public.checkout_settings where id=true),false) then raise exception ''Cash on delivery is currently unavailable''; end if;
    if subtotal+tax<799 then raise exception ''Cash on delivery requires ₹799 before delivery charges''; end if;
   end if;');
 if position('subtotal+tax<1000' in definition)>0 then raise exception 'COD policy replacement failed'; end if;
 execute definition;
end $$;
commit;
