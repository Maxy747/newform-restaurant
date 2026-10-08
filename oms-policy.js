export { nextStatuses } from './supabase/functions/_shared/security.js';
export const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const money=value=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:2}).format(Number(value)||0);
export const statusLabel=value=>({new:'Order placed',confirmed:'Confirmed',preparing:'Cooking',ready:'Ready',out_for_delivery:'Out for delivery',completed:'Completed',cancelled:'Cancelled',awaiting_payment:'Awaiting payment',not_required:'Arrange with restaurant',pending:'Pending',paid:'Paid',failed:'Failed',refunded:'Refunded',open:'Open',in_progress:'In progress',resolved:'Resolved',delivery:'Delivery',takeaway:'Takeaway',dine_in:'Dine in'}[value]||String(value||'').replaceAll('_',' '));
export function indiaDayRange(day) {
  const start=new Date(day+'T00:00:00+05:30');
  return {start:start.toISOString(),end:new Date(+start+86400000).toISOString()};
}
export function hasDeliveryDetails(profile,kind='delivery') {
  return Boolean(profile?.full_name?.trim()&&profile?.phone?.trim()&&(kind!=='delivery'||profile?.default_address?.trim()));
}
export const COD_MINIMUM=799;
// Cash option shown at checkout: COD for delivery (admin toggle + minimum before delivery charge), counter payment otherwise.
export function cashOption(kind,codEnabled,foodTotal) {
  if(kind!=='delivery')return {value:'cash',enabled:true,title:'Pay at counter',hint:kind==='dine_in'?'Cash or UPI at the table':'Cash or UPI on pickup'};
  if(!codEnabled)return {value:'cod',enabled:false,title:'COD',hint:'Currently unavailable'};
  if(foodTotal<COD_MINIMUM)return {value:'cod',enabled:false,title:'COD',hint:`Available from ₹${COD_MINIMUM} onwards`};
  return {value:'cod',enabled:true,title:'COD',hint:'Pay on delivery'};
}
// order_events: 'order.created' marks placement, 'order.<status>' each later transition.
export function stepTimes(events) {
  const times=new Map();
  for(const event of events||[]) {
    if(event.event_type==='order.created')times.set('new',event.created_at);
    else if(event.event_type?.startsWith('order.'))times.set(event.event_type.slice(6),event.created_at);
  }
  return times;
}
export function trackingCopy(order) {
  const ready={delivery:['Packed and ready','Waiting for our delivery partner to pick it up.'],takeaway:['Ready for pickup','Collect your order at the counter.'],dine_in:['Ready','Your food is on its way to your table.']};
  return ({
   new:['Order received','Waiting for the restaurant to confirm.'],
   awaiting_payment:['Waiting for payment','Complete payment to send this order to the kitchen.'],
   confirmed:['Order confirmed','The kitchen will start on it shortly.'],
   preparing:['Being prepared','Our kitchen is cooking your food.'],
   ready:ready[order.order_type]||ready.takeaway,
   out_for_delivery:['On the way','Your order is out for delivery.'],
   completed:['Completed','Enjoy your meal. Thank you for ordering from NEWFORM!'],
   cancelled:['Order cancelled','Contact the restaurant if this was unexpected.'],
  })[order.order_status]||[statusLabel(order.order_status),''];
}
// Daily order number (#1, #2… restarting each India day); short unique ref as fallback and for lookups.
export const orderRef=order=>String(order?.id||'').slice(0,8).toUpperCase();
export const orderNumber=order=>order?.daily_number?`#${order.daily_number}`:`#${orderRef(order)}`;
