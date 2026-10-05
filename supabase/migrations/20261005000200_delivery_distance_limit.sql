-- Enforce for new writes without altering historical orders or quotes.
alter table public.orders add constraint orders_delivery_40km
 check (delivery_distance_m is null or delivery_distance_m <= 40000) not valid;
alter table public.delivery_quotes add constraint quotes_delivery_40km
 check (distance_m <= 40000) not valid;
