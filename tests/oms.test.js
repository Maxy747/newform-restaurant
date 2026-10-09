import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {validHmac,canViewOrder,canClaim,nextStatuses,publicOrder,sha256} from '../supabase/functions/_shared/security.js';
import {escapeHTML,hasDeliveryDetails,indiaDayRange} from '../oms-policy.js';
import {createHmac} from 'node:crypto';

test('Payment signatures, authorization and UI helpers',async()=>{
 const signature=createHmac('sha256','secret').update('order|payment').digest('hex');
 assert.equal(await validHmac('order|payment',signature,'secret'),true);
 assert.equal(await validHmac('tampered',signature,'secret'),false);
 assert.equal(await validHmac('order|payment','bad','secret'),false);
 assert.equal((await sha256('token')).length,64);
 const order={user_id:'alice',order_type:'delivery',order_status:'new',payment_method:'razorpay',payment_status:'pending',phone:'private',delivery_address:'private'};
 assert.equal(canViewOrder(order,'bob','customer'),false);
 assert.equal(canViewOrder(order,null,'customer',true),true);
 assert.equal(canViewOrder(order,'alice','customer'),true);
 assert.equal(canViewOrder(order,'bob','delivery'),false);
 assert.equal(canViewOrder(order,'bob','kitchen'),false);
 assert.deepEqual(nextStatuses(order,'admin'),['cancelled']);
 assert.equal(publicOrder(order,'kitchen').phone,undefined);
 assert.equal(publicOrder(order,'customer').user_id,undefined);
 const ready={order_type:'delivery',order_status:'ready',payment_method:'cod',payment_status:'pending',assigned_driver:null,driver:{display_name:'Ravi',phone:'9999999999'}};
 assert.equal(canViewOrder(ready,'d1','delivery'),true); // unassigned ready orders are open to every driver
 assert.equal(canClaim(ready,'delivery','d1'),true);
 assert.equal(canClaim(ready,'staff','d1'),false);
 assert.deepEqual(nextStatuses(ready,'delivery','d1'),[]);
 const mine={...ready,assigned_driver:'d1',order_status:'out_for_delivery'};
 assert.equal(canViewOrder(mine,'d1','delivery'),true);
 assert.equal(canViewOrder(mine,'d2','delivery'),false);
 assert.equal(canClaim({...ready,assigned_driver:'d2'},'delivery','d1'),false);
 assert.deepEqual(nextStatuses(mine,'delivery','d1'),['completed']);
 assert.deepEqual(nextStatuses(mine,'delivery','d2'),[]);
 assert.deepEqual(publicOrder(mine,'customer').driver,{display_name:'Ravi'});
 assert.equal(publicOrder(mine,'customer').assigned_driver,undefined);
 assert.equal(publicOrder(mine,'staff').driver.phone,'9999999999');
 assert.equal(escapeHTML('<img src="x">'), '&lt;img src=&quot;x&quot;&gt;');
 assert.equal(hasDeliveryDetails({full_name:'A',phone:'123',default_address:'Road'}),true);
 assert.equal(hasDeliveryDetails({full_name:'A',phone:'123'}),false);
 assert.equal(indiaDayRange('2026-09-20').start,'2026-09-19T18:30:00.000Z');
});

test('PostgreSQL migration and order/payment/RLS lifecycle',async t=>{
 const db=new PGlite();
 const user='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',admin='33333333-3333-4333-8333-333333333333',kitchen='44444444-4444-4444-8444-444444444444',delivery='55555555-5555-4555-8555-555555555555';
 try {
 await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
 create schema auth;create schema storage;
 create table auth.users(id uuid primary key,email text);
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to authenticated,anon,service_role;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid primary key,bucket_id text);
 insert into auth.users values('${user}','a@test.invalid'),('${other}','b@test.invalid'),('${admin}','admin@test.invalid'),('${kitchen}','k@test.invalid'),('${delivery}','d@test.invalid');`);
 await db.exec(await readFile(new URL('../supabase_schema.sql',import.meta.url),'utf8'));
 await db.exec(`insert into public.profiles(id,role) values('${user}','staff'),('${admin}','admin');
 insert into public.menu_items(id,name,category,diet,"portionType",price) values('single','Paneer','veg','veg','single',220);
 insert into public.menu_items(id,name,category,diet,"portionType","pricesJSON") values('multi','Mandhi','mandhi','non-veg','multi','{"quarter":240,"half":420,"full":740}');`);
 await db.exec(await readFile(new URL('../supabase/migrations/20260920114250_restaurant_order_management.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/migrations/20260923061317_menu_categories.sql',import.meta.url),'utf8'));
 await t.test('categories are publicly readable but only admins can add, rename, archive and restore',async()=>{
  await db.exec('set role anon');
  assert.ok((await db.query('select * from public.menu_categories')).rows.length >= 8);
  await assert.rejects(db.exec("insert into public.menu_categories(id,name) values('bad','Bad')"),/permission denied/);
  await db.exec(`reset role; set role authenticated; set request.jwt.claim.sub='${user}'`);
  await assert.rejects(db.exec("insert into public.menu_categories(id,name) values('bad','Bad')"),/row-level security/);
  assert.equal((await db.query("update public.menu_categories set name='Forged' where id='mandhi' returning id")).rows.length,0);
  await db.exec(`set request.jwt.claim.sub='${admin}'`);
  await db.exec("insert into public.menu_categories(id,name) values('dessert','Desserts'); update public.menu_categories set name='Rice',archived=true where id='mandhi'");
  assert.equal((await db.query("select category from public.menu_items where id='multi'")).rows[0].category,'mandhi');
  await db.exec("update public.menu_categories set archived=false where id='mandhi'");
  await assert.rejects(db.exec("update public.menu_categories set name=' ' where id='mandhi'"),/check constraint/);
  await assert.rejects(db.exec("delete from public.menu_categories where id='mandhi'"),/permission denied/);
  await db.exec('reset role');
 });
 await db.exec(`insert into public.restaurant_roles(user_id,role) values('${kitchen}','kitchen'),('${delivery}','delivery');`);
 const q=async(sql,args=[]) => (await db.query(sql,args)).rows;
 const create=async({who=user,method='whatsapp',items=[{id:'multi',portion:'quarter',quantity:2,price:1}],kind='delivery',request=crypto.randomUUID(),hash='a'.repeat(64)}={})=>{
  return (await q('select public.oms_create_order($1,$2,$3,$4,$5,$6) id',[who,request,hash,JSON.stringify({name:'Test Customer',phone:'9999999999',address:'Test Road',order_type:kind,table:'3'}),JSON.stringify(items),method]))[0].id;
 };
 let oid;
 await t.test('server prices, snapshots, idempotency and guest checkout',async()=>{
  const request=crypto.randomUUID();oid=await create({request});assert.equal(await create({request}),oid);
  const o=(await q('select * from public.orders where id=$1',[oid]))[0];assert.equal(Number(o.total),504);assert.equal(o.items[0].price,240);
  assert.equal((await q('select * from public.order_items where order_id=$1',[oid])).length,1);
  await assert.rejects(create({request,who:other}),/already used/);
  assert.ok(await create({who:null,kind:'takeaway',method:'cash'}));
  await assert.rejects(create({method:'cod'}),/1,000/);
  await assert.rejects(create({items:[{id:'multi',portion:'invalid',quantity:1}]}),/portion/);
  await assert.rejects(create({items:[{id:'single',quantity:-1}]}),/quantity/);
  await assert.rejects(create({items:[]}),/50 items/);
  await q("update public.menu_items set available=false where id='single'");
  await assert.rejects(create({items:[{id:'single',quantity:1}]}),/unavailable/);
 });
 await t.test('RLS and service-only RPCs prevent forged orders and role escalation',async()=>{
  await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${other}',false);`);
  assert.equal((await q('select * from public.orders')).length,0);
  await assert.rejects(q("insert into public.orders(id) values(gen_random_uuid())"),/permission denied/);
  await assert.rejects(create(),/permission denied/);
  await db.exec(`select set_config('request.jwt.claim.sub','${user}',false);`);
  await assert.rejects(q("update public.profiles set role='admin'"),/permission denied/);
  await q("update public.profiles set full_name='Saved name'");
  assert.ok((await q('select * from public.orders')).length>0);
  assert.equal((await q('select * from public.restaurant_roles')).length,0);
  await db.exec(`select set_config('request.jwt.claim.sub','${admin}',false);`);
  await q("update public.profiles set full_name='Admin name'");
  await db.exec('reset role;');
 });
 await t.test('role-based sequential transitions, cash separate from delivery',async()=>{
  const change=(actor,status,cash=false)=>q('select public.oms_change_order($1,$2,$3,$4)',[oid,actor,status,cash]);
  await assert.rejects(change(user,'confirmed'),/Staff access/);
  await assert.rejects(change(admin,'completed'),/transition/);
  await change(kitchen,'confirmed');await change(kitchen,'preparing');await change(kitchen,'ready');
  await assert.rejects(change(kitchen,'out_for_delivery'),/transition/);
  await change(delivery,'out_for_delivery');await change(delivery,null,true);await change(delivery,'completed');
  const o=(await q('select * from public.orders where id=$1',[oid]))[0];assert.equal(o.payment_status,'paid');assert.equal(o.order_status,'completed');
  await assert.rejects(change(admin,'cancelled'),/transition/);
 });
 await t.test('payment verification amounts, duplicate/out-of-order events and refunds',async()=>{
  const id=await create({method:'razorpay'});
  await q("update public.payments set razorpay_order_id='order_test' where order_id=$1",[id]);
  const apply=(event,status='paid',amount=50400,payment='pay_test',refund=0)=>q('select public.oms_apply_payment($1,$2,$3,$4,$5,$6,$7)',[event,'order_test',payment,amount,'INR',status,refund]);
  await assert.rejects(apply('wrong','paid',1),/mismatch/);
  await assert.rejects(q('select public.oms_change_order($1,$2,$3,false)',[id,admin,'confirmed']),/transition/);
  await apply('success');await apply('success');await apply('late_failure','failed',50400,'pay_failed');
  assert.equal((await q('select payment_status from public.orders where id=$1',[id]))[0].payment_status,'paid');
  assert.equal((await q("select * from public.payment_events where event_id='success'")).length,1);
  await apply('partial','refunded',50400,'pay_test',10000);
  assert.equal((await q('select status from public.payments where order_id=$1',[id]))[0].status,'paid');
  await apply('refund','refunded',50400,'pay_test',50400);await apply('late_capture');
  assert.equal((await q('select payment_status from public.orders where id=$1',[id]))[0].payment_status,'refunded');
 });
 await t.test('tickets retain conversation and customer replies reopen resolved issues',async()=>{
  const ticket=(await q('select public.oms_ticket($1,null,$2,$3,false,null) id',[oid,'Missing item','Please help']))[0].id;
  await q('select public.oms_ticket($1,$2,null,$3,true,$4)',[oid,ticket,'We have fixed it','resolved']);
  await q('select public.oms_ticket($1,$2,null,$3,false,$4)',[oid,ticket,'Still missing','resolved']);
  assert.equal((await q('select status from public.support_tickets where id=$1',[ticket]))[0].status,'open');
  assert.equal((await q('select * from public.ticket_messages where ticket_id=$1',[ticket])).length,3);
  await assert.rejects(q('select public.oms_ticket($1,$2,null,$3,false,null)',[crypto.randomUUID(),ticket,'Invalid']),/not found/);
 });
 await t.test('service_role can execute validated checkout, rate limits and analytics',async()=>{
  await db.exec('set role service_role');assert.ok(await create());
  assert.equal((await q("select public.oms_rate_limit('test',1) ok"))[0].ok,true);
  assert.equal((await q("select public.oms_rate_limit('test',1) ok"))[0].ok,false);
  const a=(await q("select public.oms_analytics(now()-interval '1 day',now()+interval '1 day') a"))[0].a;
  assert.ok(a.orders>0);assert.ok(a.top_items.length>0);await db.exec('reset role');
 });
 await t.test('delivery quotes are protected, required, single-use and included atomically in payments',async()=>{
  await db.exec(await readFile(new URL('../supabase/migrations/20261005000100_delivery_quotes.sql',import.meta.url),'utf8'));
  await db.exec('set role anon');await assert.rejects(q('select * from public.delivery_quotes'),/permission denied/);await db.exec('reset role');
  const quote=(await q('insert into public.delivery_quotes(user_id,latitude,longitude,distance_m,fee) values($1,11,76,7000,30) returning id',[user]))[0].id;
  const customer={name:'Test Customer',phone:'9999999999',address:'Test address',order_type:'delivery',quote_id:quote};
  const request=crypto.randomUUID();
  const args=[user,request,'c'.repeat(64),customer,[{id:'multi',portion:'quarter',quantity:2}],'razorpay'];
  await db.exec('set role service_role');
  const call=()=>q('select public.oms_create_order($1,$2,$3,$4,$5,$6) id',args.map(x=>typeof x==='object'?JSON.stringify(x):x));
  const id=(await call())[0].id;
  assert.equal((await call())[0].id,id);
  assert.equal(Number((await q('select total from public.orders where id=$1',[id]))[0].total),534);
  assert.equal(Number((await q('select amount_paise from public.payments where order_id=$1',[id]))[0].amount_paise),53400);
  args[1]=crypto.randomUUID();await assert.rejects(call(),/quote expired/);
  delete customer.quote_id;await assert.rejects(call(),/quote expired/);
  customer.order_type='takeaway';assert.ok((await call())[0].id);
  await db.exec('reset role');
 });
 await t.test('COD respects Rs799 threshold and persistent disable setting',async()=>{
  await db.exec(await readFile(new URL('../supabase/migrations/20261008000100_cod_settings.sql',import.meta.url),'utf8'));
  await db.exec('set role authenticated');
  await assert.rejects(q('update public.checkout_settings set cod_enabled=false'),/permission denied/);
  await db.exec('reset role');
  await q(`insert into public.menu_items(id,name,category,diet,"portionType",price) values('cod-boundary','Test','veg','veg','single',761)`);
  const place=async()=>{
   const quote=(await q('insert into public.delivery_quotes(user_id,latitude,longitude,distance_m,fee) values($1,11,76,1000,100) returning id',[user]))[0].id;
   return q('select public.oms_create_order($1,$2,$3,$4,$5,$6) id',[user,crypto.randomUUID(),'d'.repeat(64),JSON.stringify({name:'Test Customer',phone:'9999999999',address:'Test Road',order_type:'delivery',quote_id:quote}),JSON.stringify([{id:'cod-boundary',quantity:1}]),'cod']);
  };
  const id=(await place())[0].id;
  assert.equal(Number((await q('select total from public.orders where id=$1',[id]))[0].total),899);
  await q("update public.menu_items set price=760 where id='cod-boundary'");
  await assert.rejects(place(),/799/);
  await q("update public.menu_items set price=761 where id='cod-boundary'");
  await q('update public.checkout_settings set cod_enabled=false');
  await assert.rejects(place(),/currently unavailable/);
  await q('update public.checkout_settings set cod_enabled=true');
  assert.ok((await place())[0].id);
 });
 await t.test('delivery switch blocks new delivery orders and reports include breakdowns',async()=>{
  const migration=await readFile(new URL('../supabase/migrations/20261008000200_delivery_toggle_and_reports.sql',import.meta.url),'utf8');
  await db.exec(migration);await db.exec(migration); // safe to re-run
  await db.exec('set role authenticated');
  await assert.rejects(q('update public.checkout_settings set delivery_enabled=false'),/permission denied/);
  await db.exec('reset role');
  const place=async type=>{
   const quote=type==='delivery'?(await q('insert into public.delivery_quotes(user_id,latitude,longitude,distance_m,fee) values($1,11,76,1000,100) returning id',[user]))[0].id:undefined;
   return q('select public.oms_create_order($1,$2,$3,$4,$5,$6) id',[user,crypto.randomUUID(),'e'.repeat(64),JSON.stringify({name:'Test Customer',phone:'9999999999',address:'Test Road',order_type:type,quote_id:quote}),JSON.stringify([{id:'cod-boundary',quantity:1}]),'cash'].map((x,i)=>i===5&&type==='delivery'?'cod':x));
  };
  await q('update public.checkout_settings set delivery_enabled=false');
  await db.exec('set role service_role');
  await assert.rejects(place('delivery'),/delivery is currently unavailable/);
  assert.ok((await place('takeaway'))[0].id);
  await db.exec('reset role');
  await q('update public.checkout_settings set delivery_enabled=true');
  await db.exec('set role service_role');
  assert.ok((await place('delivery'))[0].id);
  const a=(await q("select public.oms_analytics(now()-interval '1 day',now()+interval '1 day') a"))[0].a;
  await db.exec('reset role');
  for(const key of ['orders','revenue','sales','avg_order','completed','cancelled','top_items','daily','hourly','by_type','by_payment'])assert.ok(key in a,key);
  assert.ok(a.sales>0&&a.avg_order>0);
  assert.equal(a.daily.reduce((s,d)=>s+d.orders,0),a.hourly.reduce((s,h)=>s+h.orders,0));
  assert.ok(a.by_type.some(b=>b.key==='takeaway')&&a.by_payment.some(b=>b.key==='cod'));
 });
 await t.test('orders get daily numbers that restart each India day',async()=>{
  const migration=await readFile(new URL('../supabase/migrations/20261008080000_daily_order_numbers.sql',import.meta.url),'utf8');
  await db.exec(migration);await db.exec(migration); // safe to re-run
  const unnumbered=(await q('select count(*)::int n from public.orders where daily_number is null'))[0].n;
  assert.equal(unnumbered,0,'existing orders are backfilled');
  const before=(await q("select coalesce(max(daily_number),0) n from public.orders where order_day=(now() at time zone 'Asia/Kolkata')::date"))[0].n;
  await db.exec('set role service_role');
  const place=()=>q('select public.oms_create_order($1,$2,$3,$4,$5,$6) id',[user,crypto.randomUUID(),'f'.repeat(64),JSON.stringify({name:'Test Customer',phone:'9999999999',order_type:'takeaway'}),JSON.stringify([{id:'cod-boundary',quantity:1}]),'cash']);
  const first=(await place())[0].id,second=(await place())[0].id;
  await db.exec('reset role');
  const rows=await q('select id,daily_number,order_day from public.orders where id=any($1) order by daily_number',[[first,second]]);
  assert.deepEqual(rows.map(r=>r.daily_number),[before+1,before+2]);
  // A new India day starts again at #1.
  const tomorrow=(await q(`insert into public.orders select (jsonb_populate_record(null::public.orders,
   to_jsonb(o)-'daily_number'-'order_day'||jsonb_build_object('id',gen_random_uuid(),'request_id',gen_random_uuid(),'created_at','2030-01-02T00:30:00+05:30'))).*
   from public.orders o where o.id=$1 returning daily_number,order_day`,[first]))[0];
  assert.equal(tomorrow.daily_number,1);
  assert.equal(String(tomorrow.order_day instanceof Date?tomorrow.order_day.toISOString().slice(0,10):tomorrow.order_day),'2030-01-02');
  await assert.rejects(q('update public.orders set daily_number=$1, order_day=$2 where id=$3',[rows[0].daily_number,rows[0].order_day,second]),/duplicate key/);
 });
 await t.test('drivers: roster, shifts, assignment, self-claim and per-driver report',async()=>{
  const staff='66666666-6666-4666-8666-666666666666',driver2='77777777-7777-4777-8777-777777777777';
  await q(`insert into auth.users values('${staff}','s@test.invalid'),('${driver2}','Driver2@test.invalid')`);
  await q(`insert into public.restaurant_roles(user_id,role) values('${staff}','staff')`);
  const migration=await readFile(new URL('../supabase/migrations/20261008090000_delivery_drivers.sql',import.meta.url),'utf8');
  await db.exec(migration);await db.exec(migration); // safe to re-run
  const existing=(await q('select display_name,active,on_shift from public.delivery_drivers where user_id=$1',[delivery]))[0];
  assert.deepEqual(existing,{display_name:'d',active:true,on_shift:false}); // backfilled from the existing delivery role
  await db.exec('set role authenticated');
  await assert.rejects(q('select * from public.delivery_drivers'),/permission denied/);
  await assert.rejects(q('select public.oms_assign_driver($1,$2,$2)',[crypto.randomUUID(),delivery]),/permission denied/);
  await db.exec('reset role');

  const save=(actor,email,name,phone=null,driverId=null)=>q('select public.oms_save_driver($1,$2,$3,$4,$5) id',[actor,driverId,email,name,phone]);
  await assert.rejects(save(staff,'driver2@test.invalid','Ravi'),/Admin access/);
  await assert.rejects(save(admin,'nobody@test.invalid','Nobody'),/sign up on the website/);
  await assert.rejects(save(admin,'k@test.invalid','Kitchen'),/already has restaurant staff access/);
  await assert.rejects(save(admin,'driver2@test.invalid','Ravi','12'),/phone/);
  await assert.rejects(save(admin,'driver2@test.invalid',' '),/name/);
  assert.equal((await save(admin,' DRIVER2@test.invalid ','Ravi','+91 98470 12345'))[0].id,driver2);
  assert.equal((await q('select role from public.restaurant_roles where user_id=$1',[driver2]))[0].role,'delivery');

  const status=(actor,driver,active,shift)=>q('select public.oms_set_driver_status($1,$2,$3,$4)',[actor,driver,active,shift]);
  await assert.rejects(status(driver2,delivery,null,true),/Not allowed/);
  await assert.rejects(status(kitchen,delivery,null,true),/Not allowed/);
  await status(delivery,delivery,null,true);

  const quote=(await q('insert into public.delivery_quotes(user_id,latitude,longitude,distance_m,fee) values($1,11,76,1000,100) returning id',[user]))[0].id;
  const id=(await q('select public.oms_create_order($1,$2,$3,$4,$5,$6) id',[user,crypto.randomUUID(),'f'.repeat(64),JSON.stringify({name:'Test Customer',phone:'9999999999',address:'Test Road',order_type:'delivery',quote_id:quote}),JSON.stringify([{id:'cod-boundary',quantity:1}]),'whatsapp']))[0].id;
  const change=(actor,next,cash=false)=>q('select public.oms_change_order($1,$2,$3,$4)',[id,actor,next,cash]);
  const assign=(actor,driver)=>q('select public.oms_assign_driver($1,$2,$3)',[id,actor,driver]);
  const assigned=async()=>(await q('select assigned_driver from public.orders where id=$1',[id]))[0].assigned_driver;

  await change(admin,'confirmed');
  await assert.rejects(assign(delivery,delivery),/once it is ready/);
  await assert.rejects(assign(kitchen,delivery),/Staff access/);
  await assert.rejects(assign(staff,driver2),/Ravi is off shift/);
  await change(admin,'preparing');await change(admin,'ready');
  await assert.rejects(change(delivery,'out_for_delivery'),/Claim this delivery/);
  await assert.rejects(assign(driver2,driver2),/Start your shift/);
  await assign(delivery,delivery);
  assert.equal(await assigned(),delivery);
  await status(staff,driver2,null,true);
  await assert.rejects(assign(driver2,driver2),/Another driver already took/);
  await assert.rejects(assign(driver2,null),/not your delivery/);
  await assert.rejects(assign(delivery,driver2),/only claim orders for themselves/);
  await assign(delivery,null); // hand back before leaving
  await assign(driver2,driver2);
  await assert.rejects(change(delivery,'out_for_delivery'),/Claim this delivery/);
  await assign(staff,delivery); // staff can reassign
  assert.equal(await assigned(),delivery);
  await assert.rejects(change(driver2,'out_for_delivery'),/Claim this delivery/);
  await change(delivery,'out_for_delivery');
  await assert.rejects(assign(delivery,null),/before leaving/);
  await assert.rejects(status(admin,delivery,false,null),/Reassign this driver's 1 active deliveries/);
  await assert.rejects(status(staff,driver2,false,null),/Admin access/);
  await change(delivery,null,true);await change(delivery,'completed');
  await assert.rejects(assign(admin,driver2),/already closed/);
  const events=(await q("select detail from public.order_events where order_id=$1 and event_type like 'driver.%' order by id",[id])).map(e=>e.detail);
  assert.deepEqual(events,['d took this delivery','Driver removed','Ravi took this delivery','Assigned to d']);

  const total=Number((await q('select total from public.orders where id=$1',[id]))[0].total);
  const report=(await q("select public.oms_driver_report(now()-interval '1 day',now()+interval '1 day') r"))[0].r;
  const row=report.find(r=>r.id===delivery);
  assert.equal(row.delivered,1);assert.equal(row.active_orders,0);
  assert.equal(Number(row.cash),504+total); // includes cash recorded in the earlier lifecycle test
  assert.equal(report.find(r=>r.id===driver2).email,'driver2@test.invalid');

  await status(admin,delivery,false,null);
  assert.equal((await q('select * from public.restaurant_roles where user_id=$1',[delivery])).length,0);
  await assert.rejects(change(delivery,'completed'),/Staff access/);
  await assert.rejects(status(admin,delivery,null,true),/disabled/);
  await status(admin,delivery,true,null);
  assert.equal((await q('select role from public.restaurant_roles where user_id=$1',[delivery]))[0].role,'delivery');
  await save(admin,null,'Ravi K',null,driver2);
  assert.deepEqual((await q('select display_name,phone from public.delivery_drivers where user_id=$1',[driver2]))[0],{display_name:'Ravi K',phone:null});
 });
 await t.test('billing: gapless invoice numbers, automatic issue, immutability and credit notes',async()=>{
  const migration=await readFile(new URL('../supabase/migrations/20261009090000_billing_invoices.sql',import.meta.url),'utf8');
  await db.exec(migration);await db.exec(migration); // safe to re-run
  const fy=async at=>(await q('select public.oms_financial_year($1) fy',[at]))[0].fy;
  assert.equal(await fy('2027-03-31T18:29:00Z'),'26-27'); // 23:59 on 31 March, India time
  assert.equal(await fy('2027-03-31T18:30:00Z'),'27-28');
  assert.equal(await fy('2026-10-09T06:00:00Z'),'26-27');
  const year=await fy(new Date().toISOString());

  await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${admin}',false);`);
  for(const table of ['invoices','credit_notes','billing_settings','billing_counters']) await assert.rejects(q(`select * from public.${table}`),/permission denied/);
  await assert.rejects(q('select public.oms_issue_invoice($1)',[crypto.randomUUID()]),/permission denied/);
  await db.exec('reset role');

  const place=async()=>(await q('select public.oms_create_order($1,$2,$3,$4,$5,$6) id',[user,crypto.randomUUID(),'9'.repeat(64),JSON.stringify({name:'Bill Customer',phone:'9999999999',order_type:'takeaway'}),JSON.stringify([{id:'cod-boundary',quantity:1}]),'cash']))[0].id;
  const finish=async(id,{pay=true}={})=>{
   for(const step of ['confirmed','preparing','ready','completed']) await q('select public.oms_change_order($1,$2,$3,false)',[id,admin,step]);
   if(pay) await q('select public.oms_change_order($1,$2,null,true)',[id,admin]);
  };
  const invoiceOf=async id=>(await q('select * from public.invoices where order_id=$1',[id]))[0];

  // Off by default: completing and paying an order issues nothing, and it cannot be enabled without details.
  const early=await place();await finish(early);
  assert.equal(await invoiceOf(early),undefined);
  await assert.rejects(q('update public.billing_settings set enabled=true'),/billing_enabled_needs_details/);
  await assert.rejects(q("update public.billing_settings set gstin='not-a-gstin'"),/check constraint/);
  await assert.rejects(q("update public.billing_settings set prefix='nf/x'"),/check constraint/);
  await q("update public.billing_settings set legal_name='Newform Restaurant',address='Kalpetta, Wayanad',gstin='32ABCDE1234F1Z5',enabled=true");

  // Cash recorded after completion issues the invoice (payment was the last condition to be met).
  const first=await place();await finish(first);
  const inv=await invoiceOf(first);
  assert.equal(inv.invoice_no,`NF/${year}/00001`);
  assert.equal(inv.seller.gstin,'32ABCDE1234F1Z5');assert.equal(inv.buyer.name,'Bill Customer');
  assert.deepEqual([inv.taxable,inv.cgst,inv.sgst,inv.round_off,inv.total].map(Number),[761,19.03,19.03,-0.06,799]);
  assert.equal(inv.lines[0].price,761);
  assert.equal((await q('select public.oms_issue_invoice($1) id',[first]))[0].id,inv.id); // idempotent
  assert.ok((await q("select 1 from public.order_events where order_id=$1 and event_type='invoice.issued'",[first])).length);

  // Paid before completion (online/prepaid path) issues on completion.
  const prepaid=await place();
  await q('select public.oms_change_order($1,$2,null,true)',[prepaid,admin]);
  assert.equal(await invoiceOf(prepaid),undefined);
  await finish(prepaid,{pay:false});
  assert.equal((await invoiceOf(prepaid)).invoice_no,`NF/${year}/00002`);

  // Completed but unpaid: no invoice and cannot be forced.
  const unpaid=await place();await finish(unpaid,{pay:false});
  assert.equal(await invoiceOf(unpaid),undefined);
  await assert.rejects(q('select public.oms_issue_invoice($1)',[unpaid]),/completed, paid/);

  // A rolled-back issue does not burn a number.
  await db.exec('begin');
  await q('select public.oms_change_order($1,$2,null,true)',[unpaid,admin]);
  await db.exec('rollback');
  await q('select public.oms_change_order($1,$2,null,true)',[unpaid,admin]);
  assert.equal((await invoiceOf(unpaid)).invoice_no,`NF/${year}/00003`);

  await assert.rejects(q("update public.invoices set total=1 where id=$1",[inv.id]),/cannot be changed/);
  await assert.rejects(q('delete from public.invoices where id=$1',[inv.id]),/cannot be changed/);

  // Credit notes: admin only, capped at what is left, and the last one nets tax exactly to zero.
  const credit=(actor,amount,reason='Customer refund')=>q('select public.oms_credit_note($1,$2,$3,$4) id',[inv.id,actor,amount,reason]);
  const staff='66666666-6666-4666-8666-666666666666';
  await assert.rejects(credit(staff,100),/Admin access/);
  await assert.rejects(credit(user,100),/Admin access/);
  await assert.rejects(credit(admin,800),/between/);
  await assert.rejects(credit(admin,0),/between/);
  await assert.rejects(credit(admin,10,'x'),/reason/);
  await credit(admin,99.9);
  await assert.rejects(credit(admin,700),/between/);
  await credit(admin,699.1);
  const notes=await q('select * from public.credit_notes where invoice_id=$1 order by seq',[inv.id]);
  assert.deepEqual(notes.map(n=>n.note_no),[`NFC/${year}/00001`,`NFC/${year}/00002`]);
  const sum=key=>notes.reduce((s,n)=>s+Number(n[key]),0);
  assert.equal(Math.round(sum('total')*100),79900);
  assert.equal(Math.round(sum('cgst')*100),1903);assert.equal(Math.round(sum('taxable')*100),76100);
  await assert.rejects(credit(admin,0.01),/between/);
  await assert.rejects(q("update public.credit_notes set reason='changed'"),/cannot be changed/);

  await db.exec('set role service_role');
  const viaApi=await place();await finish(viaApi); // the Edge Function's role can complete orders and trigger issuing
  assert.equal((await invoiceOf(viaApi)).invoice_no,`NF/${year}/00004`);
  await assert.rejects(q("update public.billing_settings set legal_name='x' returning id").then(()=>q('select * from public.billing_counters')),/permission denied/);
  const summary=(await q("select public.oms_billing_summary(now()-interval '1 day',now()+interval '1 day') s"))[0].s;
  await db.exec('reset role');
  await q("update public.billing_settings set legal_name='Newform Restaurant'");
  assert.equal(summary.invoices,4);assert.equal(summary.credit_notes,2);
  assert.equal(Number(summary.total),799*4);assert.equal(Number(summary.credit_total),799);
  assert.equal(Math.round(Number(summary.cgst)*100),1903*4);
 });
 } finally {await db.close();}
});
