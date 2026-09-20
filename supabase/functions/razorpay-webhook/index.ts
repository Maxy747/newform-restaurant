import {rpc,razorpay} from '../_shared/server.js';
import {validHmac,sha256} from '../_shared/security.js';
Deno.serve(async req=>{
 if(req.method!=='POST') return new Response('Method not allowed',{status:405});
 const raw=await req.text();
 if(raw.length>100000) return new Response('Too large',{status:413});
 if(!await validHmac(raw,req.headers.get('x-razorpay-signature'),Deno.env.get('RAZORPAY_WEBHOOK_SECRET'))) return new Response('Invalid signature',{status:401});
 try {
  const event=JSON.parse(raw);
  if(!['payment.captured','payment.failed','refund.processed'].includes(event.event)) return Response.json({received:true});
  const paymentId=event.payload?.payment?.entity?.id||event.payload?.refund?.entity?.payment_id;
  if(!/^pay_[a-zA-Z0-9]+$/.test(paymentId||'')) return new Response('Invalid payment',{status:400});
  // Read canonical provider state: handle retries and events delivered out of order.
  const p=await razorpay('payments/'+paymentId);
  const status=p.status==='refunded'?'refunded':p.status==='captured'?(p.amount_refunded>0?'refunded':'paid'):p.status==='failed'?'failed':null;
  if(status) await rpc('oms_apply_payment',{p_event:req.headers.get('x-razorpay-event-id')||await sha256(raw),p_rz_order:p.order_id,p_payment:p.id,p_amount:p.amount,p_currency:p.currency,p_status:status,p_refunded:p.amount_refunded||0});
  return Response.json({received:true});
 } catch(error) {
  console.error('payment.webhook_failed',{message:error instanceof Error?error.message:'Unknown error'});
  return new Response('Retry required',{status:500});
 }
});
