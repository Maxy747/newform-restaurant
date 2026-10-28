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
 await t.test('delivery is Rs20 per road km within 6km (replaces the flat Rs100)',async()=>{
  // Production applied the flat-fee policy first; replay it, then the per-km migration (twice: re-runnable).
  await db.exec(await readFile(new URL('../supabase/migrations/20261006000300_flat_delivery.sql',import.meta.url),'utf8'));
  // Production had unused Rs100 quotes when this migration ran; it must expire them, not fail on them.
  const stale=(await q('insert into public.delivery_quotes(user_id,latitude,longitude,distance_m,fee) values($1,11,76,922,100) returning id',[user]))[0].id;
  const migration=await readFile(new URL('../supabase/migrations/20261009120000_delivery_per_km.sql',import.meta.url),'utf8');
  await db.exec(migration);await db.exec(migration);
  assert.ok((await q('select expires_at<=now() expired from public.delivery_quotes where id=$1',[stale]))[0].expired,'old Rs100 quote expired');
  const quote=(distance,fee)=>q('insert into public.delivery_quotes(user_id,latitude,longitude,distance_m,fee) values($1,11,76,$2,$3) returning id',[user,distance,fee]);
  await assert.rejects(quote(1000,100),/quotes_delivery_per_km/);
  await assert.rejects(quote(6500,130),/quotes_delivery_6km/);
  const id=(await quote(3400,68))[0].id;
  await db.exec('set role service_role');
  const order=(await q('select public.oms_create_order($1,$2,$3,$4,$5,$6) id',[user,crypto.randomUUID(),'a1'.repeat(32),JSON.stringify({name:'Test Customer',phone:'9999999999',address:'Test Road',order_type:'delivery',quote_id:id}),JSON.stringify([{id:'cod-boundary',quantity:1}]),'cod']))[0].id;
  await db.exec('reset role');
  const row=(await q('select delivery_fee,delivery_distance_m,total,subtotal,tax from public.orders where id=$1',[order]))[0];
  assert.equal(Number(row.delivery_fee),68);
  assert.equal(Number(row.total),Number(row.subtotal)+Number(row.tax)+68);
  // A later edit that breaks the formula is refused; untouched history is not re-checked.
  await assert.rejects(q('update public.orders set delivery_fee=100 where id=$1',[order]),/Rs20 per km/);
  assert.equal(Number((await q('select public.delivery_fee_for(6000) f'))[0].f),120);
 });
 await t.test('counter billing: paid walk-in sales are invoiced at once and cancellations are credited',async()=>{
  const migration=await readFile(new URL('../supabase/migrations/20261009150000_counter_billing.sql',import.meta.url),'utf8');
  await db.exec(migration);await db.exec(migration); // safe to re-run
  const sell=(actor,{customer={order_type:'takeaway'},items=[{id:'multi',portion:'quarter',quantity:1}],method='cash',request=crypto.randomUUID()}={})=>
   q('select public.oms_counter_order($1,$2,$3,$4,$5) id',[actor,request,JSON.stringify(customer),JSON.stringify(items),method]).then(r=>r[0].id);
  const order=async id=>(await q('select * from public.orders where id=$1',[id]))[0];
  const invoice=async id=>(await q('select * from public.invoices where order_id=$1',[id]))[0];

  await assert.rejects(sell(kitchen),/Manager access/);
  await assert.rejects(sell(user),/Manager access/);
  await assert.rejects(sell(admin,{customer:{order_type:'delivery'}}),/takeaway or dine in/);
  await assert.rejects(sell(admin,{method:'cod'}),/cash or UPI/);
  await assert.rejects(sell(admin,{customer:{order_type:'takeaway',phone:'12'}}),/valid phone/);
  await assert.rejects(sell(admin,{customer:{order_type:'dine_in'}}),/table number/);
  await assert.rejects(sell(admin,{items:[{id:'multi',portion:'quarter',quantity:1,price:1}],customer:{order_type:'takeaway',name:'x'}}),/2–100/);

  // Anonymous walk-in, cash: server prices, confirmed for the kitchen, paid and invoiced in one step.
  const request=crypto.randomUUID();
  const walkIn=await sell(admin,{request,items:[{id:'multi',portion:'quarter',quantity:1,price:1}]});
  const o=await order(walkIn);
  assert.deepEqual([o.source,o.user_id,o.created_by,o.customer_name,o.phone,o.order_status,o.payment_status,o.payment_method,Number(o.total)],
   ['counter',null,admin,'Walk-in customer','','confirmed','paid','cash',252]);
  assert.ok(o.daily_number>0);
  const inv=await invoice(walkIn);
  assert.equal(Number(inv.total),252);assert.equal(inv.buyer.phone,null);assert.equal(inv.payment_method,'cash');
  assert.equal(await sell(admin,{request}),walkIn); // a retried request returns the same sale
  await assert.rejects(sell('66666666-6666-4666-8666-666666666666',{request}),/already used/);
  assert.deepEqual((await q("select detail from public.order_events where order_id=$1 and event_type<>'invoice.issued' order by id",[walkIn])).map(e=>e.detail),['Order placed','confirmed','Paid at counter (cash)']);

  // Named dine-in paid by UPI; the kitchen finishes it without a second invoice.
  const table=await sell('66666666-6666-4666-8666-666666666666',{method:'upi',customer:{order_type:'dine_in',table:'7',name:'Asha',phone:'+91 98470 11111'}});
  assert.equal((await order(table)).payment_method,'upi');assert.equal((await invoice(table)).buyer.table,'7');
  const change=(actor,status)=>q('select public.oms_change_order($1,$2,$3,false)',[table,actor,status]);
  await change(kitchen,'preparing');await change(kitchen,'ready');await change(admin,'completed');
  assert.equal((await order(table)).order_status,'completed');
  assert.equal((await q('select count(*)::int n from public.invoices where order_id=$1',[table]))[0].n,1);

  // Cancelling an invoiced sale credits the whole invoice automatically.
  await q('select public.oms_change_order($1,$2,$3,false)',[walkIn,admin,'cancelled']);
  const notes=await q('select * from public.credit_notes where invoice_id=$1',[inv.id]);
  assert.equal(notes.length,1);assert.equal(Number(notes[0].total),252);assert.equal(notes[0].reason,'Order cancelled');
  assert.equal(Number(notes[0].cgst),Number(inv.cgst));

  // Online orders still wait for completion before invoicing.
  const online=(await q('select public.oms_create_order($1,$2,$3,$4,$5,$6) id',[user,crypto.randomUUID(),'7'.repeat(64),JSON.stringify({name:'Online Customer',phone:'9999999999',order_type:'takeaway'}),JSON.stringify([{id:'multi',portion:'quarter',quantity:1}]),'cash']))[0].id;
  await q('select public.oms_change_order($1,$2,null,true)',[online,admin]);
  assert.equal(await invoice(online),undefined);
  assert.equal((await order(online)).source,'online');

  await db.exec('set role service_role');
  assert.ok(await sell(admin,{method:'upi'})); // the Edge Function's role can ring up sales
  await db.exec('reset role');
  await db.exec('set role authenticated');
  await assert.rejects(sell(admin),/permission denied/);
  await db.exec('reset role');
 });
 await t.test('cash count: expected drawer cash by payment source, refunds, denominations and immutability',async()=>{
  const migration=await readFile(new URL('../supabase/migrations/20261009180000_cash_counts.sql',import.meta.url),'utf8');
  await db.exec(migration);await db.exec(migration); // safe to re-run
  const today=(await q("select (now() at time zone 'Asia/Kolkata')::date::text d"))[0].d;
  const summary=async(day=today)=>(await q('select public.oms_cash_summary($1::date) s',[day]))[0].s;
  const n=value=>Number(value);
  const before=await summary();
  assert.ok(n(before.driver_cash)>0&&n(before.driver_cash_count)>0); // cash the driver recorded in the drivers test
  const sell=(method,request=crypto.randomUUID())=>q('select public.oms_counter_order($1,$2,$3,$4,$5) id',[admin,request,JSON.stringify({order_type:'takeaway'}),JSON.stringify([{id:'multi',portion:'quarter',quantity:1}]),method]).then(r=>r[0].id);
  const cash1=await sell('cash'),cash2=await sell('cash'),upi=await sell('upi'); // ₹252 each
  // A pay-at-counter online order marked paid by staff also lands in the drawer.
  const online=(await q('select public.oms_create_order($1,$2,$3,$4,$5,$6) id',[user,crypto.randomUUID(),'6'.repeat(64),JSON.stringify({name:'Online Customer',phone:'9999999999',order_type:'takeaway'}),JSON.stringify([{id:'multi',portion:'quarter',quantity:2}]),'cash']))[0].id;
  await q('select public.oms_change_order($1,$2,null,true)',[online,admin]); // ₹504
  await q('select public.oms_change_order($1,$2,$3,false)',[cash2,admin,'cancelled']); // cash handed back
  await q('select public.oms_change_order($1,$2,$3,false)',[upi,admin,'cancelled']);
  const after=await summary();
  const delta=key=>n(after[key])-n(before[key]);
  assert.equal(delta('counter_cash'),504);assert.equal(delta('counter_cash_count'),2);
  assert.equal(delta('staff_cash'),504);assert.equal(delta('driver_cash'),0);
  assert.equal(delta('cash_refunds'),252);assert.equal(delta('upi'),252);assert.equal(delta('upi_refunds'),252);
  assert.equal(delta('expected_cash'),504+504-252);
  assert.equal(n((await summary('2001-01-01')).expected_cash),0); // other days are separate
  assert.ok(cash1);

  const count=(actor,{day=today,opening=2000,counted=null,denoms=null,note=null}={})=>q('select public.oms_cash_count($1,$2::date,$3,$4,$5,$6) id',[actor,day,opening,counted,denoms&&JSON.stringify(denoms),note]).then(r=>r[0].id);
  await assert.rejects(count(kitchen,{counted:1}),/Manager access/);
  await assert.rejects(count(admin,{day:'2001-01-01',counted:1}),/last 7 days/);
  await assert.rejects(count(admin,{opening:-1,counted:1}),/opening float/);
  await assert.rejects(count(admin,{}),/cash counted/);
  await assert.rejects(count(admin,{denoms:{'2000':1}}),/Invalid count for ₹2000/);
  await assert.rejects(count(admin,{denoms:{'100':1.5}}),/Invalid count/);
  // Denominations win over a typed total: 3×500 + 2×100 + 7×1 = 1707.
  const id=await count('66666666-6666-4666-8666-666666666666',{counted:99999,denoms:{'500':3,'100':2,'1':7},note:' Shift A '});
  const saved=(await q('select * from public.cash_counts where id=$1',[id]))[0];
  const expected=2000+n(after.expected_cash);
  assert.deepEqual([n(saved.counted),n(saved.expected),n(saved.difference),saved.note],[1707,expected,1707-expected,'Shift A']);
  assert.equal(n(saved.summary.expected_cash),n(after.expected_cash));
  await assert.rejects(q('update public.cash_counts set counted=0 where id=$1',[id]),/cannot be changed/);
  await assert.rejects(q('delete from public.cash_counts where id=$1',[id]),/cannot be changed/);

  await db.exec('set role service_role');
  assert.ok(await count(admin,{counted:expected})); // the API role can save counts
  await db.exec('reset role');
  await db.exec('set role authenticated');
  await assert.rejects(q('select * from public.cash_counts'),/permission denied/);
  await db.exec('reset role');
 });
 await t.test('website theme setting and admin-managed gallery',async()=>{
  const migration=await readFile(new URL('../supabase/migrations/20261013090000_site_theme_and_gallery.sql',import.meta.url),'utf8');
  await db.exec(migration);
  assert.equal((await q('select site_theme from public.checkout_settings'))[0].site_theme,'light');
  await q("update public.checkout_settings set site_theme='ivory'");
  await assert.rejects(q("update public.checkout_settings set site_theme='neon'"),/site_theme_check/);
  await db.exec('set role authenticated');
  await assert.rejects(q("update public.checkout_settings set site_theme='dark'"),/permission denied/);
  await db.exec('reset role');
  // Everyone can read the six launch photos, in order.
  await db.exec('set role anon');
  const seeded=await q('select caption,image_url from public.gallery_photos order by sort_order');
  assert.equal(seeded.length,6);
  assert.equal(seeded[0].image_url,'gallery/exterior-aerial-dusk-full.webp');
  await assert.rejects(q("insert into public.gallery_photos(image_url,thumb_url) values('https://x.test/a.webp','https://x.test/b.webp')"),/permission denied/);
  await db.exec('reset role');
  const add=url=>q('insert into public.gallery_photos(image_url,thumb_url) values($1,$1) returning id',[url]);
  // Staff (not admin) can't add, re-caption or delete; RLS hides the change.
  await db.exec(`set role authenticated; set request.jwt.claim.sub='${user}'`);
  await assert.rejects(add('https://x.test/staff.webp'),/row-level security/);
  assert.equal((await q("update public.gallery_photos set caption='Forged' returning id")).length,0);
  assert.equal((await q('delete from public.gallery_photos returning id')).length,0);
  // Admins can.
  await db.exec(`set request.jwt.claim.sub='${admin}'`);
  const id=(await add('https://crlivalipmeypovsubca.supabase.co/storage/v1/object/public/gallery-photos/a-full.webp'))[0].id;
  assert.equal((await q("update public.gallery_photos set caption='Terrace at night' where id=$1 returning caption",[id]))[0].caption,'Terrace at night');
  await assert.rejects(q('update public.gallery_photos set image_url=$1 where id=$2',['https://x.test/c.webp',id]),/permission denied/); // only caption/order are editable
  await assert.rejects(add('javascript:alert(1)'),/check constraint/);
  await assert.rejects(add('https://x.test/"><script>'),/check constraint/);
  assert.equal((await q('delete from public.gallery_photos where id=$1 returning id',[id])).length,1);
  await db.exec('reset role');
  assert.equal((await q("select public from storage.buckets where id='gallery-photos'"))[0].public,true);
  await db.exec(await readFile(new URL('../supabase/migrations/20261013100000_default_site_theme_ivory.sql',import.meta.url),'utf8'));
  assert.equal((await q('select site_theme from public.checkout_settings'))[0].site_theme,'ivory');
  const tagMigration=await readFile(new URL('../supabase/migrations/20261013110000_stock_photo_tag.sql',import.meta.url),'utf8');
  await db.exec(tagMigration);await db.exec(tagMigration); // safe to re-run
  assert.equal((await q('select show_stock_tag from public.checkout_settings'))[0].show_stock_tag,true);
  await db.exec('set role authenticated');
  await assert.rejects(q('update public.checkout_settings set show_stock_tag=false'),/permission denied/);
  await db.exec('reset role');
  assert.equal((await q("select column_default from information_schema.columns where table_name='checkout_settings' and column_name='site_theme'"))[0].column_default,"'ivory'::text");
  const uiMigration=await readFile(new URL('../supabase/migrations/20261028090000_site_ui.sql',import.meta.url),'utf8');
  await db.exec(uiMigration);await db.exec(uiMigration); // safe to re-run
  assert.equal((await q('select site_ui from public.checkout_settings'))[0].site_ui,'modern');
  await q("update public.checkout_settings set site_ui='classic'");
  await assert.rejects(q("update public.checkout_settings set site_ui='retro'"),/site_ui_check/);
  await db.exec('set role authenticated');
  await assert.rejects(q("update public.checkout_settings set site_ui='modern'"),/permission denied/);
  await db.exec('reset role');
  await q("update public.checkout_settings set site_ui='modern'");
  const splashMigration=await readFile(new URL('../supabase/migrations/20261028120000_splash_style.sql',import.meta.url),'utf8');
  await db.exec(splashMigration);await db.exec(splashMigration); // safe to re-run
  assert.equal((await q('select splash_style from public.checkout_settings'))[0].splash_style,'classic');
  await q("update public.checkout_settings set splash_style='modern'");
  await assert.rejects(q("update public.checkout_settings set splash_style='retro'"),/splash_style_check/);
  await db.exec('set role authenticated');
  await assert.rejects(q("update public.checkout_settings set splash_style='classic'"),/permission denied/);
  await db.exec('reset role');
  await q("update public.checkout_settings set splash_style='classic'");
  const altMigration=await readFile(new URL('../supabase/migrations/20261028160000_splash_style_modern_alt.sql',import.meta.url),'utf8');
  await db.exec(altMigration);await db.exec(altMigration); // safe to re-run
  await q("update public.checkout_settings set splash_style='modern-alt'");
  await assert.rejects(q("update public.checkout_settings set splash_style='retro'"),/splash_style_check/);
  await q("update public.checkout_settings set splash_style='classic'");
  const pagesMigration=await readFile(new URL('../supabase/migrations/20261028150000_site_pages.sql',import.meta.url),'utf8');
  await db.exec(pagesMigration);await db.exec(pagesMigration); // safe to re-run
  assert.equal((await q('select site_pages from public.checkout_settings'))[0].site_pages,'single');
  await q("update public.checkout_settings set site_pages='multi'");
  await assert.rejects(q("update public.checkout_settings set site_pages='tabs'"),/site_pages_check/);
  await db.exec('set role authenticated');
  await assert.rejects(q("update public.checkout_settings set site_pages='single'"),/permission denied/);
  await db.exec('reset role');
  await q("update public.checkout_settings set site_pages='single'");
 });
 await t.test('admin Razorpay refunds: admin-only, capped at what was paid, idempotent per request',async()=>{
  const migration=await readFile(new URL('../supabase/migrations/20261020090000_razorpay_refunds.sql',import.meta.url),'utf8');
  await db.exec(migration);await db.exec(migration); // safe to re-run
  const order=async rz=>{
   const id=(await q('select public.oms_create_order($1,$2,$3,$4,$5,$6) id',[user,crypto.randomUUID(),'7'.repeat(64),JSON.stringify({name:'Online Customer',phone:'9999999999',order_type:'takeaway'}),JSON.stringify([{id:'multi',portion:'quarter',quantity:2}]),'razorpay']))[0].id;
   await q('update public.payments set razorpay_order_id=$1 where order_id=$2',[rz,id]);
   return id;
  };
  const id=await order('order_refund');
  const request=(amount,{who=admin,req=crypto.randomUUID(),reason='Out of stock',oid=id}={})=>q('select public.oms_request_refund($1,$2,$3,$4,$5) r',[who,oid,req,amount,reason]).then(r=>r[0].r);
  const record=(refund,rz,status,failure=null)=>q('select public.oms_record_refund($1,$2,$3,$4)',[refund,rz,status,failure]);
  await assert.rejects(request(100),/Only paid online orders/); // not paid yet
  await q('select public.oms_apply_payment($1,$2,$3,$4,$5,$6,$7)',['refund_paid','order_refund','pay_refund',50400,'INR','paid',0]);
  await assert.rejects(request(100,{who:user}),/Admin access/); // staff can't refund
  await assert.rejects(request(100,{who:kitchen}),/Admin access/);
  await assert.rejects(request(0),/amount/);
  await assert.rejects(request(100,{reason:' a '}),/reason/);
  await assert.rejects(request(50401),/up to ₹504\.00/);
  const cash=(await q("select id from public.orders where payment_method<>'razorpay' limit 1"))[0].id;
  await assert.rejects(request(100,{oid:cash}),/paid online/);

  // Partial refund, then replaying the same request returns the same row instead of reserving again.
  const req=crypto.randomUUID();
  const first=await request(10000,{req});
  assert.equal(first.status,'requested');assert.equal(first.payment_id,'pay_refund');
  assert.equal((await request(10000,{req})).id,first.id);
  await assert.rejects(request(20000,{req}),/already used/);
  assert.equal((await q('select count(*)::int n from public.refunds where order_id=$1',[id]))[0].n,1);
  await assert.rejects(request(40401),/up to ₹404\.00/); // unconfirmed requests still reserve their amount

  // Razorpay accepts it, then processes it; processed is final.
  await assert.rejects(record(first.id,'bad id','pending'),/Invalid Razorpay refund/);
  await record(first.id,'rfnd_one','pending');
  await assert.rejects(record(first.id,'rfnd_other','processed'),/identity mismatch/);
  await record(null,'rfnd_one','processed'); // the webhook finds it by Razorpay's id
  await record(null,'rfnd_one','failed');
  await record(null,'rfnd_dashboard','processed'); // Dashboard refunds have no row and are ignored
  assert.deepEqual((await q('select status,razorpay_refund_id from public.refunds where id=$1',[first.id]))[0],{status:'processed',razorpay_refund_id:'rfnd_one'});
  const events=(await q("select event_type from public.order_events where order_id=$1 and event_type like 'refund.%' order by id",[id])).map(r=>r.event_type);
  assert.deepEqual(events,['refund.requested','refund.pending','refund.processed']);

  // A refusal frees its reservation, so the full remainder can still be refunded.
  const refused=await request(40400);
  await record(refused.id,null,'failed','The payment has been fully refunded already.');
  assert.equal((await q('select failure_reason from public.refunds where id=$1',[refused.id]))[0].failure_reason,'The payment has been fully refunded already.');
  const rest=await request(40400);
  await assert.rejects(request(1),/Nothing is left/);
  await record(rest.id,'rfnd_two','processed');
  // Razorpay's payment sync marks the order refunded; no more refunds.
  await q('select public.oms_apply_payment($1,$2,$3,$4,$5,$6,$7)',['refund:rfnd_two','order_refund','pay_refund',50400,'INR','refunded',50400]);
  assert.equal((await q('select payment_status from public.orders where id=$1',[id]))[0].payment_status,'refunded');
  await assert.rejects(request(1),/already been fully refunded/);

  // A Dashboard refund larger than ours caps what Admin can refund.
  const other=await order('order_refund_2');
  await q('select public.oms_apply_payment($1,$2,$3,$4,$5,$6,$7)',['refund2_paid','order_refund_2','pay_refund_2',50400,'INR','paid',0]);
  await q('select public.oms_apply_payment($1,$2,$3,$4,$5,$6,$7)',['refund2_dash','order_refund_2','pay_refund_2',50400,'INR','refunded',30000]);
  await assert.rejects(request(20401,{oid:other}),/up to ₹204\.00/);
  assert.ok((await request(20400,{oid:other})).id);

  await assert.rejects(q("insert into public.refunds(order_id,request_id,amount_paise,reason) values($1,$2,0,'Out of stock')",[id,crypto.randomUUID()]),/check constraint/);
  await db.exec('set role authenticated');
  await assert.rejects(q('select * from public.refunds'),/permission denied/);
  await assert.rejects(request(100),/permission denied/);
  await db.exec('reset role');
  await db.exec('set role service_role');
  await assert.rejects(q('delete from public.refunds'),/permission denied/);
  await assert.rejects(q('update public.refunds set amount_paise=1'),/permission denied/);
  await db.exec('reset role');
 });
 } finally {await db.close();}
});
