begin;
-- Counter billing: staff ring up walk-in takeaway / dine-in sales that are paid on the spot (cash or UPI)
-- and invoiced immediately. Safe to re-run. Requires the billing and delivery-drivers migrations.

alter table public.orders add column if not exists source text not null default 'online';
alter table public.orders drop constraint if exists orders_source_check;
alter table public.orders add constraint orders_source_check check(source in ('online','counter'));
alter table public.orders add column if not exists created_by uuid references auth.users(id) on delete set null;

-- UPI is recorded separately from cash so the cash drawer can be reconciled.
alter table public.orders drop constraint if exists orders_payment_method_check;
alter table public.orders add constraint orders_payment_method_check check(payment_method in ('whatsapp','cod','cash','razorpay','upi'));

-- Counter sales are invoiced when paid; online orders still wait until they are completed.
create or replace function public.oms_invoice_due(o public.orders) returns boolean
language sql immutable set search_path='' as $$
 select o.payment_status='paid' and (o.order_status='completed' or (o.source='counter' and o.order_status<>'cancelled'))
$$;

create or replace function public.oms_issue_invoice(p_order uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare o public.orders; s public.billing_settings; inv uuid; yr text; n integer; half numeric;
begin
 select * into o from public.orders where id=p_order for update;
 if not found then raise exception 'Order not found'; end if;
 select id into inv from public.invoices where order_id=p_order;
 if inv is not null then return inv; end if;
 select * into s from public.billing_settings where id;
 if not found or not s.enabled then return null; end if;
 if not public.oms_invoice_due(o) then raise exception 'Only completed, paid orders can be invoiced'; end if;
 yr=public.oms_financial_year(now());
 n=public.oms_next_billing_no('INV',yr);
 half=round(o.subtotal*0.025,2);
 insert into public.invoices(order_id,invoice_no,financial_year,seq,seller,buyer,lines,payment_method,taxable,cgst,sgst,delivery_fee,round_off,total)
 values(o.id,s.prefix||'/'||yr||'/'||lpad(n::text,5,'0'),yr,n,
  jsonb_build_object('legal_name',s.legal_name,'address',s.address,'phone',s.phone,'gstin',s.gstin,'fssai',s.fssai,'sac',s.sac,'footer',s.footer),
  jsonb_build_object('name',o.customer_name,'phone',nullif(o.phone,''),'address',nullif(o.delivery_address,''),'table',o.table_number,'order_type',o.order_type),
  o.items,o.payment_method,o.subtotal,half,half,coalesce(o.delivery_fee,0),
  o.total-o.subtotal-2*half-coalesce(o.delivery_fee,0),o.total)
 returning id into inv;
 insert into public.order_events(order_id,actor_id,event_type,detail) values(o.id,null,'invoice.issued','Invoice '||s.prefix||'/'||yr||'/'||lpad(n::text,5,'0')||' issued');
 return inv;
end $$;

-- Credit-note body shared by the admin action and automatic cancellation credits.
create or replace function public.oms_credit_note_internal(p_invoice uuid,p_actor uuid,p_amount numeric,p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare i public.invoices; s public.billing_settings; done record; remaining numeric; amt numeric; t numeric; c numeric; g numeric; yr text; n integer; note uuid;
begin
 select * into i from public.invoices where id=p_invoice for update;
 if not found then raise exception 'Invoice not found'; end if;
 if char_length(btrim(coalesce(p_reason,''))) not between 3 and 200 then raise exception 'Give a reason (3–200 characters)'; end if;
 select coalesce(sum(taxable),0) taxable,coalesce(sum(cgst),0) cgst,coalesce(sum(sgst),0) sgst,coalesce(sum(total),0) total
  into done from public.credit_notes where invoice_id=p_invoice;
 remaining=i.total-done.total;
 amt=round(coalesce(p_amount,0),2);
 if amt<=0 or amt>remaining then raise exception 'Credit amount must be between ₹0.01 and ₹%', remaining; end if;
 if amt=remaining then
  t=i.taxable-done.taxable; c=i.cgst-done.cgst; g=i.sgst-done.sgst;
 else
  t=round(i.taxable*amt/i.total,2); c=round(i.cgst*amt/i.total,2); g=round(i.sgst*amt/i.total,2);
 end if;
 select * into s from public.billing_settings where id;
 yr=public.oms_financial_year(now());
 n=public.oms_next_billing_no('CN',yr);
 insert into public.credit_notes(invoice_id,note_no,financial_year,seq,reason,taxable,cgst,sgst,other,total,created_by)
 values(i.id,s.prefix||'C/'||yr||'/'||lpad(n::text,5,'0'),yr,n,btrim(p_reason),t,c,g,amt-t-c-g,amt,p_actor)
 returning id into note;
 insert into public.order_events(order_id,actor_id,event_type,detail) values(i.order_id,p_actor,'invoice.credited','Credit note '||s.prefix||'C/'||yr||'/'||lpad(n::text,5,'0')||' issued');
 update public.order_signals set updated_at=clock_timestamp() where order_id=i.order_id;
 return note;
end $$;

create or replace function public.oms_credit_note(p_invoice uuid,p_actor uuid,p_amount numeric,p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
begin
 if public.oms_actor_role(p_actor) is distinct from 'admin' then raise exception 'Admin access required'; end if;
 return public.oms_credit_note_internal(p_invoice,p_actor,p_amount,p_reason);
end $$;

-- Issues the invoice when one becomes due, and fully credits an invoiced order that is cancelled.
create or replace function public.orders_issue_invoice() returns trigger
language plpgsql security definer set search_path='' as $$
declare inv public.invoices; credited numeric;
begin
 if public.oms_invoice_due(new) and not public.oms_invoice_due(old) then
  perform public.oms_issue_invoice(new.id);
 end if;
 if new.order_status='cancelled' and old.order_status is distinct from 'cancelled' then
  select * into inv from public.invoices where order_id=new.id;
  if found then
   select coalesce(sum(total),0) into credited from public.credit_notes where invoice_id=inv.id;
   if inv.total>credited then perform public.oms_credit_note_internal(inv.id,null,inv.total-credited,'Order cancelled'); end if;
  end if;
 end if;
 return null;
end $$;

-- A paid counter sale in one transaction: server prices (same rules as online checkout), confirmed for
-- the kitchen, marked paid, invoiced. Retrying with the same request id returns the same order.
create or replace function public.oms_counter_order(p_actor uuid,p_request uuid,p_customer jsonb,p_items jsonb,p_method text) returns uuid
language plpgsql security invoker set search_path='' as $$
declare kind text=p_customer->>'order_type'; who text=nullif(btrim(coalesce(p_customer->>'name','')),'');
 tel text=nullif(btrim(coalesce(p_customer->>'phone','')),''); existing public.orders; oid uuid;
begin
 if public.oms_actor_role(p_actor) is null or public.oms_actor_role(p_actor) not in ('admin','staff') then raise exception 'Manager access required'; end if;
 if p_request is null then raise exception 'Invalid request'; end if;
 if p_method is null or p_method not in ('cash','upi') then raise exception 'Choose cash or UPI'; end if;
 if kind is null or kind not in ('takeaway','dine_in') then raise exception 'Counter bills are for takeaway or dine in'; end if;
 if who is not null and char_length(who) not between 2 and 100 then raise exception 'Enter a name of 2–100 characters, or leave it blank'; end if;
 if tel is not null and tel !~ '^\+?[0-9 ()-]{8,20}$' then raise exception 'Enter a valid phone number, or leave it blank'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,0));
 select * into existing from public.orders where request_id=p_request;
 if found then
  if existing.source='counter' and existing.created_by is not distinct from p_actor then return existing.id; end if;
  raise exception 'Request already used';
 end if;
 -- Walk-ins have no account or tracking key; the base checkout still needs a name, phone and key hash.
 oid=public.oms_create_order_base(null,p_request,md5(random()::text||clock_timestamp()::text)||md5(p_request::text||random()::text),
  jsonb_build_object('order_type',kind,'table',p_customer->>'table','name',coalesce(who,'Walk-in customer'),'phone',coalesce(tel,'0000000000')),p_items,'cash');
 update public.orders set source='counter',created_by=p_actor,customer_name=coalesce(who,'Walk-in customer'),phone=coalesce(tel,''),
  payment_method=p_method,order_status='confirmed' where id=oid;
 insert into public.order_events(order_id,actor_id,event_type,detail) values(oid,p_actor,'order.confirmed','confirmed');
 update public.orders set payment_status='paid' where id=oid;
 insert into public.order_events(order_id,actor_id,event_type,detail) values(oid,p_actor,'payment.updated',case p_method when 'upi' then 'Paid at counter (UPI)' else 'Paid at counter (cash)' end);
 update public.order_signals set updated_at=clock_timestamp() where order_id=oid;
 return oid;
end $$;

revoke all on function public.oms_invoice_due(public.orders),public.oms_issue_invoice(uuid),public.oms_credit_note_internal(uuid,uuid,numeric,text),
 public.oms_credit_note(uuid,uuid,numeric,text),public.orders_issue_invoice(),public.oms_counter_order(uuid,uuid,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.oms_issue_invoice(uuid),public.oms_credit_note(uuid,uuid,numeric,text),
 public.oms_counter_order(uuid,uuid,jsonb,jsonb,text) to service_role;
commit;
