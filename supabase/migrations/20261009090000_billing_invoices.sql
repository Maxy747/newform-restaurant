begin;
-- Billing: numbered invoices for completed, paid orders, plus credit notes for later refunds/adjustments.
-- Safe to re-run. Invoicing stays OFF until an admin enters business details and turns it on.

create table if not exists public.billing_settings (
 id boolean primary key default true check(id),
 enabled boolean not null default false,
 legal_name text not null default '' check(char_length(legal_name)<=120),
 address text not null default '' check(char_length(address)<=300),
 phone text check(phone is null or char_length(phone)<=40),
 gstin text check(gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
 fssai text check(fssai is null or fssai ~ '^[0-9]{14}$'),
 sac text not null default '996331' check(sac ~ '^[0-9]{4,8}$'),
 prefix text not null default 'NF' check(prefix ~ '^[A-Z0-9]{1,3}$'),
 footer text not null default '' check(char_length(footer)<=200),
 updated_at timestamptz not null default now(),
 constraint billing_enabled_needs_details check(not enabled or (char_length(btrim(legal_name))>0 and char_length(btrim(address))>0))
);
insert into public.billing_settings(id) values(true) on conflict(id) do nothing;

-- One row per series and financial year. Incremented inside the issuing transaction, so a rollback
-- also rolls back the number: no gaps (unlike a sequence) and no duplicates.
create table if not exists public.billing_counters (
 series text not null check(series in ('INV','CN')),
 financial_year text not null check(financial_year ~ '^[0-9]{2}-[0-9]{2}$'),
 last_no integer not null check(last_no>0),
 primary key(series,financial_year)
);

create table if not exists public.invoices (
 id uuid primary key default gen_random_uuid(),
 order_id uuid not null unique references public.orders(id),
 invoice_no text not null unique,
 financial_year text not null,
 seq integer not null check(seq>0),
 issued_at timestamptz not null default now(),
 seller jsonb not null,
 buyer jsonb not null,
 lines jsonb not null,
 payment_method text,
 taxable numeric(12,2) not null,
 cgst numeric(12,2) not null,
 sgst numeric(12,2) not null,
 delivery_fee numeric(12,2) not null default 0,
 round_off numeric(12,2) not null default 0,
 total numeric(12,2) not null check(total>0),
 unique(financial_year,seq),
 constraint invoice_balances check(total=taxable+cgst+sgst+delivery_fee+round_off)
);
create index if not exists invoices_issued_at_idx on public.invoices(issued_at desc);

create table if not exists public.credit_notes (
 id uuid primary key default gen_random_uuid(),
 invoice_id uuid not null references public.invoices(id),
 note_no text not null unique,
 financial_year text not null,
 seq integer not null check(seq>0),
 issued_at timestamptz not null default now(),
 reason text not null check(char_length(btrim(reason)) between 3 and 200),
 taxable numeric(12,2) not null,
 cgst numeric(12,2) not null,
 sgst numeric(12,2) not null,
 other numeric(12,2) not null default 0,
 total numeric(12,2) not null check(total>0),
 created_by uuid,
 unique(financial_year,seq),
 constraint credit_note_balances check(total=taxable+cgst+sgst+other)
);
create index if not exists credit_notes_invoice_idx on public.credit_notes(invoice_id);
create index if not exists credit_notes_issued_at_idx on public.credit_notes(issued_at desc);

alter table public.billing_settings enable row level security;
alter table public.billing_counters enable row level security;
alter table public.invoices enable row level security;
alter table public.credit_notes enable row level security;
revoke all on public.billing_settings,public.billing_counters,public.invoices,public.credit_notes from public,anon,authenticated,service_role;
-- The API reads invoices and edits settings; issuing goes only through the functions below.
grant select,update on public.billing_settings to service_role;
grant select on public.invoices,public.credit_notes to service_role;

-- Issued documents are permanent. Corrections are made with a credit note, never by editing.
create or replace function public.billing_documents_immutable() returns trigger
language plpgsql set search_path='' as $$
begin
 raise exception 'Issued invoices and credit notes cannot be changed or deleted';
end $$;
drop trigger if exists invoices_immutable on public.invoices;
create trigger invoices_immutable before update or delete on public.invoices
 for each row execute function public.billing_documents_immutable();
drop trigger if exists credit_notes_immutable on public.credit_notes;
create trigger credit_notes_immutable before update or delete on public.credit_notes
 for each row execute function public.billing_documents_immutable();

-- Indian financial year (April–March) in India time, e.g. 2026-10-09 -> '26-27'.
create or replace function public.oms_financial_year(p_at timestamptz) returns text
language sql stable set search_path='' as $$
 select case when extract(month from d)>=4 then to_char(d,'YY')||'-'||to_char(d+interval '1 year','YY')
  else to_char(d-interval '1 year','YY')||'-'||to_char(d,'YY') end
 from (select (p_at at time zone 'Asia/Kolkata')::date as d) x
$$;

create or replace function public.oms_next_billing_no(p_series text,p_year text) returns integer
language sql set search_path='' as $$
 insert into public.billing_counters(series,financial_year,last_no) values(p_series,p_year,1)
 on conflict(series,financial_year) do update set last_no=public.billing_counters.last_no+1
 returning last_no
$$;

-- Issues the invoice for a completed, paid order. Returns the existing invoice if there is one,
-- or null while invoicing is turned off. The order row lock serializes concurrent callers.
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
 if o.order_status<>'completed' or o.payment_status<>'paid' then raise exception 'Only completed, paid orders can be invoiced'; end if;
 yr=public.oms_financial_year(now());
 n=public.oms_next_billing_no('INV',yr);
 -- 5% restaurant GST split equally between CGST and SGST (intra-state). The order already stores
 -- whole-rupee tax; any difference from the exact split is shown as round-off so totals still match.
 half=round(o.subtotal*0.025,2);
 insert into public.invoices(order_id,invoice_no,financial_year,seq,seller,buyer,lines,payment_method,taxable,cgst,sgst,delivery_fee,round_off,total)
 values(o.id,s.prefix||'/'||yr||'/'||lpad(n::text,5,'0'),yr,n,
  jsonb_build_object('legal_name',s.legal_name,'address',s.address,'phone',s.phone,'gstin',s.gstin,'fssai',s.fssai,'sac',s.sac,'footer',s.footer),
  jsonb_build_object('name',o.customer_name,'phone',o.phone,'address',o.delivery_address,'table',o.table_number,'order_type',o.order_type),
  o.items,o.payment_method,o.subtotal,half,half,coalesce(o.delivery_fee,0),
  o.total-o.subtotal-2*half-coalesce(o.delivery_fee,0),o.total)
 returning id into inv;
 insert into public.order_events(order_id,actor_id,event_type,detail) values(o.id,null,'invoice.issued','Invoice '||s.prefix||'/'||yr||'/'||lpad(n::text,5,'0')||' issued');
 return inv;
end $$;

-- Issues automatically the moment an order is both completed and paid, whichever happens last.
create or replace function public.orders_issue_invoice() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.order_status='completed' and new.payment_status='paid' and
  (old.order_status is distinct from 'completed' or old.payment_status is distinct from 'paid') then
  perform public.oms_issue_invoice(new.id);
 end if;
 return null;
end $$;
drop trigger if exists orders_issue_invoice on public.orders;
create trigger orders_issue_invoice after update of order_status,payment_status on public.orders
 for each row execute function public.orders_issue_invoice();

-- Admin-only credit note against an invoice, up to the amount not yet credited. Tax is reversed in
-- proportion; the final credit note takes exactly what remains so the totals net to zero.
create or replace function public.oms_credit_note(p_invoice uuid,p_actor uuid,p_amount numeric,p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare i public.invoices; s public.billing_settings; done record; remaining numeric; amt numeric; t numeric; c numeric; g numeric; yr text; n integer; note uuid;
begin
 if public.oms_actor_role(p_actor) is distinct from 'admin' then raise exception 'Admin access required'; end if;
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

-- GST summary by issue date for the accountant: invoices, credit notes and the net.
create or replace function public.oms_billing_summary(p_start timestamptz,p_end timestamptz) returns jsonb
language sql stable security invoker set search_path='' as $$
 with i as (select * from public.invoices where issued_at>=p_start and issued_at<p_end),
 c as (select * from public.credit_notes where issued_at>=p_start and issued_at<p_end)
 select jsonb_build_object(
  'invoices',(select count(*) from i),
  'taxable',(select coalesce(sum(taxable),0) from i),
  'cgst',(select coalesce(sum(cgst),0) from i),
  'sgst',(select coalesce(sum(sgst),0) from i),
  'delivery',(select coalesce(sum(delivery_fee),0) from i),
  'round_off',(select coalesce(sum(round_off),0) from i),
  'total',(select coalesce(sum(total),0) from i),
  'credit_notes',(select count(*) from c),
  'credit_taxable',(select coalesce(sum(taxable),0) from c),
  'credit_cgst',(select coalesce(sum(cgst),0) from c),
  'credit_sgst',(select coalesce(sum(sgst),0) from c),
  'credit_total',(select coalesce(sum(total),0) from c)
 )
$$;

revoke all on function public.billing_documents_immutable(),public.oms_financial_year(timestamptz),public.oms_next_billing_no(text,text),
 public.oms_issue_invoice(uuid),public.orders_issue_invoice(),public.oms_credit_note(uuid,uuid,numeric,text),
 public.oms_billing_summary(timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.oms_financial_year(timestamptz),public.oms_issue_invoice(uuid),
 public.oms_credit_note(uuid,uuid,numeric,text),public.oms_billing_summary(timestamptz,timestamptz) to service_role;
commit;
