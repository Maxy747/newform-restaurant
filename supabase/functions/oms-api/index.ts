import {db,checked,rpc,razorpay,paymentConfigured} from '../_shared/server.js';
import {requireUUID,sha256,validHmac,canViewOrder,publicOrder} from '../_shared/security.js';
import {roadQuote,addressLocation} from '../_shared/delivery.js';
import {shopStatus,ORDERING_MODES} from '../_shared/hours.js';
import {normalizeBillingSettings} from '../_shared/billing.js';
import {parseOrigins,originAllowed,corsOrigin} from '../_shared/origins.js';
import {providerPaymentStatus,refundPaise,refundRejected,refundStatus,matchingRefund} from '../_shared/refunds.js';

const origins=parseOrigins(Deno.env.get('SITE_ORIGINS'),Deno.env.get('SITE_ORIGIN'));
// Access-Control-Allow-Origin is set per request in Deno.serve below (it depends on the caller's origin).
const headers={'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json','Cache-Control':'no-store','Vary':'Origin'};
// Website themes an admin can pick for every visitor (see checkout_settings.site_theme).
const SITE_THEMES=['light','ivory','dark'];
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers});
Deno.serve(async req=>{
 const response=await handle(req);
 response.headers.set('Access-Control-Allow-Origin',corsOrigin(req.headers.get('origin'),origins));
 return response;
});
async function handle(req:Request):Promise<Response>{
 if(req.method==='OPTIONS') return new Response(null,{headers});
 if(req.method!=='POST') return json({error:'Method not allowed'},405);
 if(!originAllowed(req.headers.get('origin'),origins)) return json({error:'Origin not allowed'},403);
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
  const orderingMode=(row:any)=>ORDERING_MODES.includes(row.ordering_mode)?row.ordering_mode:'auto';
  if(body.action==='config') {
   const current=await settings();
   return json({role,codEnabled:current.cod_enabled,deliveryEnabled:deliveryOn(current),orderingMode:orderingMode(current),shopOpen:shopStatus(orderingMode(current)).open,siteTheme:SITE_THEMES.includes(current.site_theme)?current.site_theme:'light',stockTag:current.show_stock_tag!==false,payments:paymentConfigured(),deliveryRouting:Boolean(Deno.env.get('ORS_API_KEY')),testMode:!(Deno.env.get('RAZORPAY_KEY_ID')||'').startsWith('rzp_live_')});
  }
  if(body.action==='set_cod') {
   if(role!=='admin') return json({error:'Admin access required'},403);
   if(typeof body.enabled!=='boolean') throw new Error('Invalid COD setting');
   const settings=checked(await db.from('checkout_settings').update({cod_enabled:body.enabled}).eq('id',true).select('cod_enabled').single());
   return json({codEnabled:settings.cod_enabled});
  }
  if(body.action==='set_site_theme') {
   if(role!=='admin') return json({error:'Admin access required'},403);
   if(!SITE_THEMES.includes(body.theme)) throw new Error('Invalid website theme');
   const updated=checked(await db.from('checkout_settings').update({site_theme:body.theme}).eq('id',true).select('site_theme').single());
   return json({siteTheme:updated.site_theme});
  }
  if(body.action==='set_stock_tag') {
   if(role!=='admin') return json({error:'Admin access required'},403);
   if(typeof body.enabled!=='boolean') throw new Error('Invalid tag setting');
   const updated=checked(await db.from('checkout_settings').update({show_stock_tag:body.enabled}).eq('id',true).select('show_stock_tag').single());
   return json({stockTag:updated.show_stock_tag});
  }
  if(body.action==='set_delivery') {
   if(role!=='admin') return json({error:'Admin access required'},403);
   if(typeof body.enabled!=='boolean') throw new Error('Invalid delivery setting');
   const updated=checked(await db.from('checkout_settings').update({delivery_enabled:body.enabled}).eq('id',true).select('delivery_enabled').single());
   return json({deliveryEnabled:updated.delivery_enabled});
  }
  if(body.action==='set_ordering_mode') {
   if(role!=='admin') return json({error:'Admin access required'},403);
   if(!ORDERING_MODES.includes(body.mode)) throw new Error('Invalid ordering setting');
   const updated=checked(await db.from('checkout_settings').update({ordering_mode:body.mode}).eq('id',true).select('ordering_mode').single());
   return json({orderingMode:updated.ordering_mode,shopOpen:shopStatus(updated.ordering_mode).open});
  }
  // Online ordering follows opening hours (or the admin override). Counter sales are separate and unaffected.
  if(['delivery_address','delivery_quote','create'].includes(body.action)) {
   const status=shopStatus(orderingMode(await settings()));
   if(!status.open) throw new Error(`We're closed right now (${status.message.replace('Closed now · ','')}). Please order during opening hours.`);
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
  // Billing requires the 20261009090000_billing_invoices migration.
  const manager=['admin','staff'].includes(role);
  const range=()=>{
   const start=new Date(body.start),end=new Date(body.end);
   if(!Number.isFinite(+start)||!Number.isFinite(+end)||+end<=+start||+end-+start>366*86400000) throw new Error('Choose a date range up to one year');
   return {p_start:start.toISOString(),p_end:end.toISOString()};
  };
  if(body.action==='billing_settings') {
   if(!manager) return json({error:'Manager access required'},403);
   return json({settings:checked(await db.from('billing_settings').select('*').eq('id',true).single())});
  }
  if(body.action==='set_billing_settings') {
   if(role!=='admin') return json({error:'Admin access required'},403);
   const row={...normalizeBillingSettings(body.settings),updated_at:new Date().toISOString()};
   return json({settings:checked(await db.from('billing_settings').update(row).eq('id',true).select('*').single())});
  }
  if(body.action==='invoices') {
   if(!manager) return json({error:'Manager access required'},403);
   const {p_start,p_end}=range();
   const size=body.export?5000:30,page=body.export?0:Math.min(10000,Math.max(0,Number(body.page)||0));
   let query=db.from('invoices').select('id,order_id,invoice_no,issued_at,buyer,payment_method,taxable,cgst,sgst,delivery_fee,round_off,total,credit_notes(total),order:orders(payment_status)',{count:'exact'})
    .gte('issued_at',p_start).lt('issued_at',p_end).order('issued_at',{ascending:false});
   if(body.search) query=query.ilike('invoice_no','%'+String(body.search).replace(/[%_\\]/g,'').slice(0,24)+'%');
   const result=await query.range(page*size,page*size+size-1); checked(result);
   return json({invoices:result.data,count:result.count,summary:await rpc('oms_billing_summary',{p_start,p_end})});
  }
  if(body.action==='credit_note') {
   if(role!=='admin') return json({error:'Admin access required'},403);
   const amount=Number(body.amount);
   if(!Number.isFinite(amount)||amount<=0) throw new Error('Enter the amount to credit');
   const id=await rpc('oms_credit_note',{p_invoice:requireUUID(body.invoiceId),p_actor:userId,p_amount:amount,p_reason:typeof body.reason==='string'?body.reason.slice(0,200):''});
   console.info('invoice.credited',{invoice:body.invoiceId});
   return json({id});
  }
  // End-of-day cash count (requires the 20261009180000_cash_counts migration).
  const businessDay=()=>{ const day=String(body.day||''); if(!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Choose a day'); return day; };
  if(body.action==='cash_day') {
   if(!manager) return json({error:'Manager access required'},403);
   const day=businessDay();
   const summary=await rpc('oms_cash_summary',{p_day:day});
   const counts=checked(await db.from('cash_counts').select('id,counted_at,counted_by,opening_float,counted,expected,difference,denominations,note').eq('business_day',day).order('counted_at',{ascending:false}));
   const ids=[...new Set(counts.map((c:any)=>c.counted_by).filter(Boolean))];
   const people=ids.length?checked(await db.from('profiles').select('id,full_name').in('id',ids)):[];
   const names=new Map(people.map((p:any)=>[p.id,p.full_name]));
   // The last float used is the usual starting point for the next count.
   const last=checked(await db.from('cash_counts').select('opening_float').order('counted_at',{ascending:false}).limit(1).maybeSingle());
   return json({summary,lastFloat:last?.opening_float??null,counts:counts.map(({counted_by,...c}:any)=>({...c,counted_by_name:names.get(counted_by)||'Staff'}))});
  }
  if(body.action==='cash_count') {
   if(!userId||!manager) return json({error:'Manager access required'},403);
   const amount=(value:unknown)=>value===null||value===undefined||value===''||!Number.isFinite(Number(value))?null:Number(value);
   const denominations=body.denominations&&typeof body.denominations==='object'&&!Array.isArray(body.denominations)?body.denominations:null;
   const id=await rpc('oms_cash_count',{p_actor:userId,p_day:businessDay(),p_opening:amount(body.opening),p_counted:amount(body.counted),p_denominations:denominations,p_note:typeof body.note==='string'?body.note.slice(0,300):null});
   console.info('cash.counted',{id});
   return json({id});
  }
  // Counter sale paid on the spot (requires the 20261009150000_counter_billing migration).
  if(body.action==='counter_order') {
   if(!userId||!manager) return json({error:'Manager access required'},403);
   const customer=body.customer&&typeof body.customer==='object'?body.customer:{};
   const id=await rpc('oms_counter_order',{p_actor:userId,p_request:requireUUID(body.requestId),p_customer:customer,p_items:Array.isArray(body.items)?body.items:[],p_method:body.method});
   const sale=checked(await db.from('orders').select(ORDER_FIELDS).eq('id',id).single());
   const issued=checked(await db.from('invoices').select('id,invoice_no').eq('order_id',id).maybeSingle());
   console.info('order.counter',{id});
   return json({order:publicOrder(sale,role),invoice:issued});
  }
  if(body.action==='ticket_list') {
   if(!['admin','staff'].includes(role)) return json({error:'Staff access required'},403);
   const tickets=checked(await db.from('support_tickets').select('*,order:orders(daily_number)').neq('status','resolved').order('updated_at',{ascending:false}).limit(100));
   return json({tickets});
  }
  const order=await access(body.id);
  if(body.action==='detail') {
   const events=checked(await db.from('order_events').select('id,event_type,detail,created_at').eq('order_id',order.id).order('created_at'));
   const tickets=['kitchen','delivery'].includes(role)?[]:checked(await db.from('support_tickets').select('*,ticket_messages(id,author_role,message,created_at)').eq('order_id',order.id).order('created_at'));
   // Ignores a missing invoices table so order tracking keeps working before the billing migration.
   const issued=['kitchen','delivery'].includes(role)?null:await db.from('invoices').select('id,invoice_no').eq('order_id',order.id).maybeSingle();
   // Online payment and refunds for managers (refunds needs the 20261020090000_razorpay_refunds migration; ignored before it).
   let payment=null,refunds:any[]=[];
   if(manager&&order.payment_method==='razorpay') {
    payment=checked(await db.from('payments').select('amount_paise,refunded_paise,status').eq('order_id',order.id).maybeSingle());
    const rows=await db.from('refunds').select('id,request_id,amount_paise,reason,status,razorpay_refund_id,failure_reason,created_at').eq('order_id',order.id).order('created_at');
    if(!rows.error) refunds=rows.data;
   }
   return json({order:publicOrder(order,role),events,tickets,invoice:issued&&!issued.error?issued.data:null,payment,refunds});
  }
  if(body.action==='invoice') {
   if(!manager) await access(order.id,false); // kitchen and drivers only get invoices for their own orders
   const invoice=checked(await db.from('invoices').select('id,order_id,invoice_no,financial_year,issued_at,seller,buyer,lines,payment_method,taxable,cgst,sgst,delivery_fee,round_off,total,credit_notes(id,note_no,issued_at,reason,taxable,cgst,sgst,other,total),order:orders(daily_number)').eq('order_id',order.id).maybeSingle());
   if(!invoice) throw new Error('No invoice has been issued for this order yet');
   return json({invoice});
  }
  if(body.action==='issue_invoice') {
   if(!manager) return json({error:'Manager access required'},403);
   const id=await rpc('oms_issue_invoice',{p_order:order.id});
   if(!id) throw new Error('Invoicing is turned off. An admin can turn it on in Settings → Invoices.');
   console.info('invoice.issued',{order:order.id});
   return json({id});
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
  // Admin refund of an online payment, full or partial (requires the 20261020090000_razorpay_refunds migration).
  if(body.action==='refund') {
   if(!userId||role!=='admin') return json({error:'Admin access required'},403);
   const listed=async(paymentId:string)=>razorpay(`payments/${paymentId}/refunds?count=100`);
   const record=(row:any,refund:any)=>rpc('oms_record_refund',{p_refund:row.id,p_rz_refund:refund.id,p_status:refundStatus(refund),p_failure:refund.status==='failed'?'Razorpay reported the refund as failed':null});
   // The row id is the Razorpay receipt: look for an earlier attempt's refund first, and a retry can't create a second one.
   const settle=async(row:any,paymentId:string)=>{
    const earlier=matchingRefund(await listed(paymentId),row.id);
    if(earlier) { await record(row,earlier); return earlier; }
    try {
     const created=await razorpay(`payments/${paymentId}/refund`,{method:'POST',body:JSON.stringify({amount:row.amount_paise,speed:'normal',receipt:row.id,notes:{restaurant_order:row.order_id,reason:row.reason}})});
     await record(row,created);
     return created;
    } catch(error) {
     if(!refundRejected(error)) throw new Error("Razorpay didn't confirm the refund. Press Refund again: retrying is safe and won't refund twice.");
     const raced=matchingRefund(await listed(paymentId),row.id); // a concurrent retry may have created it
     if(raced) { await record(row,raced); return raced; }
     const reason=(error as any).description||'no reason given';
     await rpc('oms_record_refund',{p_refund:row.id,p_rz_refund:null,p_status:'failed',p_failure:reason});
     throw new Error('Razorpay refused the refund: '+reason);
    }
   };
   const amount=refundPaise(body.amount),requestId=requireUUID(body.requestId);
   const payment=checked(await db.from('payments').select('razorpay_payment_id').eq('order_id',order.id).maybeSingle());
   if(!payment?.razorpay_payment_id) throw new Error('Only paid online orders can be refunded');
   // Finish any earlier attempt on this order that Razorpay never confirmed before reserving more.
   const stale=checked(await db.from('refunds').select('*').eq('order_id',order.id).eq('status','requested').neq('request_id',requestId));
   for(const row of stale) await settle(row,payment.razorpay_payment_id);
   const claim=await rpc('oms_request_refund',{p_actor:userId,p_order:order.id,p_request:requestId,p_amount:amount,p_reason:typeof body.reason==='string'?body.reason.slice(0,200):''});
   const refund=claim.status==='requested'?await settle(claim,claim.payment_id):{id:claim.razorpay_refund_id,status:claim.status};
   console.info('order.refund',{id:order.id,refund:refund.id});
   // The webhook also does this; syncing now shows the refunded amount straight away.
   try {
    const p=await razorpay('payments/'+claim.payment_id);
    const status=providerPaymentStatus(p);
    if(refund.id&&status==='refunded') await rpc('oms_apply_payment',{p_event:'refund:'+refund.id,p_rz_order:p.order_id,p_payment:p.id,p_amount:p.amount,p_currency:p.currency,p_status:status,p_refunded:p.amount_refunded||0});
   } catch(error) { console.error('order.refund_sync_failed',{id:order.id,message:error instanceof Error?error.message:'Unknown error'}); }
   return json({refund:{id:refund.id,status:refundStatus(refund)}});
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
}
