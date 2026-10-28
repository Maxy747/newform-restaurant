begin;
-- "stock": restaurant admins may mark dishes in or out of stock even when the owner has turned
-- Menu editing off. Only the oms-api set_stock action uses it (it changes nothing else).
alter table public.checkout_settings alter column admin_access set default
 '{"counter":true,"tickets":true,"drivers":true,"reports":true,"billing":true,"menu":false,"stock":true,"operations":true,"design":false,"money":true}'::jsonb;
update public.checkout_settings set admin_access = admin_access || '{"stock":true}'::jsonb where id and not admin_access ? 'stock';
commit;
