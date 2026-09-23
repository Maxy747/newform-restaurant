begin;
create table public.menu_categories (
 id text primary key check (id <> 'all' and length(id) between 1 and 100),
 name text not null check (length(btrim(name)) between 1 and 60),
 sort_order integer not null default 0,
 archived boolean not null default false
);
alter table public.menu_categories enable row level security;
revoke all on public.menu_categories from anon, authenticated;
grant select on public.menu_categories to anon, authenticated;
grant insert on public.menu_categories to authenticated;
grant update(name,sort_order,archived) on public.menu_categories to authenticated;
grant all on public.menu_categories to service_role;
create policy "Public reads categories" on public.menu_categories for select to anon,authenticated using (true);
create policy "Admins add categories" on public.menu_categories for insert to authenticated
 with check (exists(select 1 from public.profiles where id=(select auth.uid()) and role='admin'));
create policy "Admins edit categories" on public.menu_categories for update to authenticated
 using (exists(select 1 from public.profiles where id=(select auth.uid()) and role='admin'))
 with check (exists(select 1 from public.profiles where id=(select auth.uid()) and role='admin'));
insert into public.menu_categories(id,name,sort_order) values
 ('mandhi','Mandhi & Rice',0),('broast_alfaham','Broast & Alfaham',1),('beef','Beef Specials',2),
 ('chicken','Chicken',3),('seafood','Seafood',4),('mutton','Mutton',5),('veg','Vegetarian',6),('kada_egg','Kada & Egg',7);
-- Preserve custom category keys already used by existing dishes.
insert into public.menu_categories(id,name,sort_order)
 select distinct category,left(initcap(replace(category,'_',' ')),60),100 from public.menu_items
 where category <> 'all' and length(category) between 1 and 100 on conflict(id) do nothing;
commit;
