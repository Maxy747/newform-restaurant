import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {validHmac,canViewOrder,nextStatuses,publicOrder,sha256} from '../supabase/functions/_shared/security.js';
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
 } finally {await db.close();}
});
