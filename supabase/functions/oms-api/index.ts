import {db,checked,rpc,razorpay,paymentConfigured} from '../_shared/server.js';
import {requireUUID,sha256,validHmac,canViewOrder,publicOrder} from '../_shared/security.js';
import {roadQuote,addressLocation} from '../_shared/delivery.js';

const origin=Deno.env.get('SITE_ORIGIN')||'https://maxy747.github.io';
const headers={'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json','Cache-Control':'no-store','Vary':'Origin'};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers});
Deno.serve(async req=>{
 if(req.method==='OPTIONS') return new Response(null,{headers});
 if(req.method!=='POST') return json({error:'Method not allowed'},405);
 if(req.headers.get('origin')&&req.headers.get('origin')!==origin) return json({error:'Origin not allowed'},403);
 try {
  const raw=await req.text(); if(raw.length>24000) return json({error:'Request too large'},413);
  const body=JSON.parse(raw); let userId:string|null=null; let role='customer';
  const auth=req.headers.get('authorization')?.replace(/^Bearer\s+/i,'');
  if(auth && auth!==Deno.env.get('SUPABASE_ANON_KEY') && !auth.startsWith('sb_publishable_')) {
   const {data,error}=await db.auth.getUser(auth);
   if(error||!data.user) return json({error:'Your session expired. Sign in again.'},401);
   userId=data.user.id;
   const profile=checked(await db.from('profiles').select('role').eq('id',userId).maybeSingle());
   const employee=checked(await db.from('restaurant_roles').select('role').eq('user_id',userId).maybeSingle());
   role=profile?.role==='admin'?'admin':employee?.role||'customer';
  }
  const identity=userId||req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||'anonymous';
  const bucket=await sha256(identity+':'+(body.action==='create'?'checkout':'api'));
  if(!await rpc('oms_rate_limit',{p_bucket:bucket,p_limit:body.action==='create'?10:120})) return json({error:'Too many requests. Please wait a minute.'},429);
  // select('*') keeps this working before and after the delivery_enabled column exists.
  const settings=async()=>checked(await db.from('checkout_settings').select('*').eq('id',true).single());
  const deliveryOn=(row:any)=>row.delivery_enabled!==false;
  if(body.action==='config') {
   const current=await settings();
   return json({role,codEnabled:current.cod_enabled,deliveryEnabled:deliveryOn(current),payments:paymentConfigured(),deliveryRouting:Boolean(Deno.env.get('ORS_API_KEY')),testMode:!(Deno.env.get('RAZORPAY_KEY_ID')||'').startsWith('rzp_live_')});
  }
  if(body.action==='set_cod') {
   if(role!=='admin') return json({error:'Admin access required'},403);
   if(typeof body.enabled!=='boolean') throw new Error('Invalid COD setting');
   const settings=checked(await db.from('checkout_settings').update({cod_enabled:body.enabled}).eq('id',true).select('cod_enabled').single());
   return json({codEnabled:settings.cod_enabled});
  }
  if(body.action==='set_delivery') {
   if(role!=='admin') return json({error:'Admin access required'},403);
   if(typeof body.enabled!=='boolean') throw new Error('Invalid delivery setting');
   const updated=checked(await db.from('checkout_settings').update({delivery_enabled:body.enabled}).eq('id',true).select('delivery_enabled').single());
   return json({deliveryEnabled:updated.delivery_enabled});
  }
  if(['delivery_address','delivery_quote'].includes(body.action)&&!deliveryOn(await settings())) throw new Error('Home delivery is currently unavailable. Please choose takeaway or dine in.');
  if(body.action==='delivery_address') {
   if(!await rpc('oms_rate_limit',{p_bucket:await sha256(identity+':geocoding'),p_limit:8})) throw new Error('Please wait a minute before searching again.');
   return json({matches:await addressLocation(body.address,Deno.env.get('ORS_API_KEY'))});
  }
  if(body.action==='delivery_quote') {
   if(!await rpc('oms_rate_limit',{p_bucket:await sha256(identity+':routing'),p_limit:8})) throw new Error('Please wait a minute before calculating another route.');
   const route=await roadQuote(body.location,Deno.env.get('ORS_API_KEY'));
   const quote=checked(await db.from('delivery_quotes').insert({...route,user_id:userId}).select('id,fee,distance_m,expires_at').single());
   return json({quote});
  }
  // Requires the delivery_drivers migration (orders.assigned_driver foreign key) to be applied first.
  const ORDER_FIELDS='*,driver:delivery_drivers(display_name,phone)';
  const access=async(id:string,allowStaff=true)=>{
   const order=checked(await db.from('orders').select(ORDER_FIELDS).eq('id',requireUUID(id)).maybeSingle());
   let guest=false;
   if(typeof body.token==='string'&&/^[a-f0-9]{64}$/.test(body.token)) {
    const key=checked(await db.from('order_access').select('token_hash').eq('order_id',id).maybeSingle());
    guest=Boolean(key&&key.token_hash===await sha256(body.token));
   }
   if(!order||!canViewOrder(order,userId,allowStaff?role:'customer',guest)) throw new Error('Order not found or access denied');
   return order;
  };
  if(body.action==='create') {
   if(body.method==='razorpay'&&!paymentConfigured()) throw new Error('Online payments are not configured yet');
   if(typeof body.token!=='string'||!/^[a-f0-9]{64}$/.test(body.token)) throw new Error('Invalid tracking key');
   const id=await rpc('oms_create_order',{p_user:userId,p_request:requireUUID(body.requestId),p_token_hash:await sha256(body.token),p_customer:body.customer,p_items:body.items,p_method:body.method});
   return json({order:publicOrder(await access(id,false))});
  }
  if(body.action==='list') {
   if(!userId) return json({orders:[],count:0});
   const requestedMode=body.mode||'customer';
   const mode=requestedMode==='customer'?'customer':role==='kitchen'?'kitchen':role==='delivery'?'delivery':requestedMode;
   if(mode!=='customer'&&role==='customer') return json({error:'Staff access required'},403);
   let query=db.from('orders').select(ORDER_FIELDS,{count:'exact'}).order('created_at',{ascending:false});
   if(mode==='customer') query=query.eq('user_id',userId);
   else if(role==='kitchen'||mode==='kitchen') query=query.in('order_status',['new','confirmed','preparing','ready']).or('payment_method.neq.razorpay,payment_status.eq.paid');
   else if(role==='delivery') query=query.eq('order_type','delivery').in('order_status',['ready','out_for_delivery','completed']).or(`assigned_driver.eq.${userId},and(assigned_driver.is.null,order_status.eq.ready)`);
   else if(mode==='delivery') query=query.eq('order_type','delivery').in('order_status',['ready','out_for_delivery','completed']);
   if(body.status) query=query.eq('order_status',body.status);
   if(body.payment) query=query.eq('payment_status',body.payment);
   if(body.type) query=query.eq('order_type',body.type);
   if(body.start) query=query.gte('created_at',new Date(body.start).toISOString());
   if(body.end) query=query.lt('created_at',new Date(body.end).toISOString());
   if(body.search) {
    const search=String(body.search).trim();
    // "#12" / "12" = daily order number (combine with a date range for a specific day).
    if(/^#?\d{1,5}$/.test(search)) query=query.eq('daily_number',Number(search.replace('#','')));
    else if(/^[a-f0-9-]{36}$/i.test(search)) query=query.eq('id',search);
    else query=query.ilike('customer_name','%'+search.replace(/[%_]/g,'').slice(0,80)+'%');
   }
   const page=Math.min(10000,Math.max(0,Number(body.page)||0));
   const result=await query.range(page*30,page*30+29); checked(result);
   return json({orders:result.data.map((o:any)=>publicOrder(o,role)),count:result.count});
  }
  if(body.action==='drivers') {
   if(role==='delivery') return json({drivers:checked(await db.from('delivery_drivers').select('user_id,display_name,phone,active,on_shift').eq('user_id',userId))
    .map((d:any)=>({id:d.user_id,name:d.display_name,phone:d.phone,active:d.active,on_shift:d.on_shift}))});
   if(!['admin','staff'].includes(role)) return json({error:'Manager access required'},403);
   const start=new Date(body.start),end=new Date(body.end);
   if(!Number.isFinite(+start)||!Number.isFinite(+end)||+end<=+start||+end-+start>366*86400000) throw new Error('Choose a date range up to one year');
   return json({drivers:await rpc('oms_driver_report',{p_start:start.toISOString(),p_end:end.toISOString()})});
  }
  if(body.action==='driver_save') {
   if(role!=='admin') return json({error:'Admin access required'},403);
   const text=(value:unknown,max:number)=>typeof value==='string'?value.slice(0,max):null;
   const id=await rpc('oms_save_driver',{p_actor:userId,p_driver:body.driverId?requireUUID(body.driverId):null,p_email:text(body.email,320),p_name:text(body.name,120),p_phone:text(body.phone,40)});
   return json({id});
  }
  if(body.action==='driver_status') {
   if(!userId||!['admin','staff','delivery'].includes(role)) return json({error:'Staff access required'},403);
   const flag=(value:unknown)=>typeof value==='boolean'?value:null;
   await rpc('oms_set_driver_status',{p_actor:userId,p_driver:requireUUID(body.driverId),p_active:flag(body.active),p_on_shift:flag(body.onShift)});
   return json({ok:true});
  }
  if(body.action==='analytics') {
   if(!['admin','staff'].includes(role)) return json({error:'Manager access required'},403);
   const start=new Date(body.start),end=new Date(body.end);
   if(!Number.isFinite(+start)||!Number.isFinite(+end)||+end<=+start||+end-+start>366*86400000) throw new Error('Choose a date range up to one year');
   return json(await rpc('oms_analytics',{p_start:start.toISOString(),p_end:end.toISOString()}));
  }
  if(body.action==='ticket_list') {
   if(!['admin','staff'].includes(role)) return json({error:'Staff access required'},403);
   const tickets=checked(await db.from('support_tickets').select('*').neq('status','resolved').order('updated_at',{ascending:false}).limit(100));
   return json({tickets});
  }
  const order=await access(body.id);
  if(body.action==='detail') {
   const events=checked(await db.from('order_events').select('id,event_type,detail,created_at').eq('order_id',order.id).order('created_at'));
   const tickets=['kitchen','delivery'].includes(role)?[]:checked(await db.from('support_tickets').select('*,ticket_messages(id,author_role,message,created_at)').eq('order_id',order.id).order('created_at'));
   return json({order:publicOrder(order,role),events,tickets});
  }
  if(body.action==='transition'||body.action==='cash') {
   if(!userId||role==='customer') return json({error:'Staff access required'},403);
   await rpc('oms_change_order',{p_id:order.id,p_actor:userId,p_status:body.status||null,p_cash:body.action==='cash'});
   console.info('order.updated',{id:order.id,action:body.action});
   return json({ok:true});
  }
  if(body.action==='assign') {
   if(!userId||!['admin','staff','delivery'].includes(role)) return json({error:'Staff access required'},403);
   await rpc('oms_assign_driver',{p_id:order.id,p_actor:userId,p_driver:body.driver?requireUUID(body.driver):null});
   console.info('order.assigned',{id:order.id});
   return json({ok:true});
  }
  if(body.action==='ticket') {
   if(['kitchen','delivery'].includes(role)) return json({error:'Support access required'},403);
   const ticket=await rpc('oms_ticket',{p_order:order.id,p_ticket:body.ticketId?requireUUID(body.ticketId):null,p_subject:body.subject||null,p_message:body.message,p_staff:['admin','staff'].includes(role),p_status:body.status||null});
   return json({ticket});
  }
  if(body.action==='pay'||body.action==='verify') {
   await access(order.id,false); // Staff permissions cannot authorize paying someone else's order.
   if(order.payment_method!=='razorpay'||['cancelled','completed'].includes(order.order_status)) throw new Error('This order is not payable');
   let payment=checked(await db.from('payments').select('*').eq('order_id',order.id).single());
   if(['paid','refunded'].includes(payment.status)) return json({paid:payment.status==='paid'});
   if(body.action==='pay') {
    if(!payment.razorpay_order_id) {
     const claim=checked(await db.from('payments').update({creation_started_at:new Date().toISOString()}).eq('order_id',order.id).is('creation_started_at',null).select('order_id'));
     if(!claim.length) throw new Error('Payment initialization is being checked. Retry shortly; if it persists, contact the restaurant.');
     // A timeout is ambiguous: retain the claim for reconciliation instead of creating duplicate provider orders.
     const provider=await razorpay('orders',{method:'POST',body:JSON.stringify({amount:payment.amount_paise,currency:'INR',receipt:order.id,notes:{restaurant_order:order.id}})});
     if(!provider.id||provider.amount!==payment.amount_paise||provider.currency!=='INR') throw new Error('Payment provider order mismatch');
     checked(await db.from('payments').update({razorpay_order_id:provider.id}).eq('order_id',order.id));
     payment.razorpay_order_id=provider.id;
    }
    return json({key:Deno.env.get('RAZORPAY_KEY_ID'),order_id:payment.razorpay_order_id,amount:payment.amount_paise,currency:'INR'});
   }
   if(body.razorpay_order_id!==payment.razorpay_order_id||!/^pay_[a-zA-Z0-9]+$/.test(body.razorpay_payment_id||'')||
      !await validHmac(payment.razorpay_order_id+'|'+body.razorpay_payment_id,body.razorpay_signature,Deno.env.get('RAZORPAY_KEY_SECRET'))) throw new Error('Payment verification failed; no payment status was changed');
   const provider=await razorpay('payments/'+body.razorpay_payment_id);
   if(provider.order_id!==payment.razorpay_order_id||provider.amount!==payment.amount_paise||provider.currency!=='INR') throw new Error('Payment details do not match');
   if(provider.status==='captured') await rpc('oms_apply_payment',{p_event:'verify:'+provider.id,p_rz_order:provider.order_id,p_payment:provider.id,p_amount:provider.amount,p_currency:provider.currency,p_status:'paid',p_refunded:0});
   return json({paid:provider.status==='captured',pending:provider.status!=='captured'});
  }
  return json({error:'Unknown action'},400);
 } catch(error) {
  console.error('oms.request_failed',{message:error instanceof Error?error.message:'Unknown error'});
  return json({error:error instanceof Error?error.message:'Request failed'},400);
 }
});
