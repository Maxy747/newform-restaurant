begin;
-- Human-friendly order numbers: #1, #2… restarting every India (Asia/Kolkata) day.
-- The order UUID stays the unique id; (order_day, daily_number) is unique too.
alter table public.orders add column if not exists order_day date;
alter table public.orders add column if not exists daily_number integer;

create table if not exists public.order_day_counters (
 day date primary key,
 last_number integer not null check (last_number > 0)
);
alter table public.order_day_counters enable row level security;
revoke all on public.order_day_counters from public, anon, authenticated;
grant select, insert, update on public.order_day_counters to service_role;

-- Number existing orders by creation time within each day. Rows that predate the
-- NOT VALID 40 km distance check are left unnumbered (updating them would fail that check);
-- the app falls back to the short reference for those.
with numbered as (
 select id, (created_at at time zone 'Asia/Kolkata')::date as day,
  row_number() over (partition by (created_at at time zone 'Asia/Kolkata')::date order by created_at, id) as n
 from public.orders
)
update public.orders o set order_day = numbered.day, daily_number = numbered.n
from numbered
where o.id = numbered.id and o.daily_number is null
 and (o.delivery_distance_m is null or o.delivery_distance_m <= 40000);

insert into public.order_day_counters(day, last_number)
 select (created_at at time zone 'Asia/Kolkata')::date, count(*) from public.orders group by 1
on conflict (day) do update set last_number = greatest(public.order_day_counters.last_number, excluded.last_number);

-- The counter row lock serialises concurrent checkouts, so two orders can never share a number.
create or replace function public.orders_assign_daily_number() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
 new.order_day := (coalesce(new.created_at, now()) at time zone 'Asia/Kolkata')::date;
 insert into public.order_day_counters(day, last_number) values (new.order_day, 1)
 on conflict (day) do update set last_number = public.order_day_counters.last_number + 1
 returning last_number into new.daily_number;
 return new;
end $$;
revoke all on function public.orders_assign_daily_number() from public, anon, authenticated;
drop trigger if exists orders_assign_daily_number on public.orders;
create trigger orders_assign_daily_number before insert on public.orders
 for each row execute function public.orders_assign_daily_number();

create unique index if not exists orders_daily_number_key on public.orders(order_day, daily_number);
commit;
