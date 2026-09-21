-- Smoke test against the deployed schema. ALL changes roll back, including realtime signals.
begin;
set local role service_role;
do $$
declare oid uuid;tid uuid;m public.menu_items;price numeric;
begin
 select * into m from public.menu_items where id='m1' and available;
 if not found then raise exception 'Known smoke-test dish is unavailable'; end if;
 oid=public.oms_create_order(null,gen_random_uuid(),repeat('a',64),
  '{"name":"Rollback-only validation","phone":"9999999999","address":"Not a real delivery","order_type":"delivery"}'::jsonb,
  jsonb_build_array(jsonb_build_object('id',m.id,'portion','quarter','quantity',1,'price',0.01)),'whatsapp');
 if (select subtotal from public.orders where id=oid)<=0.01 then raise exception 'Client price was trusted'; end if;
 tid=public.oms_ticket(oid,null,'Rollback test','Rollback-only test message',false,null);
 perform public.oms_ticket(oid,tid,null,'Test response',true,'resolved');
 if (select status from public.support_tickets where id=tid)<>'resolved' then raise exception 'Ticket failed'; end if;
end $$;
rollback;
select (select count(*) from public.orders) as orders_after_rollback,
 (select count(*) from public.support_tickets) as tickets_after_rollback;
