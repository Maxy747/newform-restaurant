export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function requireUUID(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Invalid order identifier');
  return value;
}
export async function sha256(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
}
export async function validHmac(message, signature, secret) {
  if (!secret || !/^[a-f0-9]{64}$/i.test(signature || '')) return false;
  const key = await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  const bytes = new Uint8Array(signature.match(/../g).map(b=>parseInt(b,16)));
  return crypto.subtle.verify('HMAC',key,bytes,new TextEncoder().encode(message));
}
export function nextStatuses(order,role) {
  if (!['admin','staff','kitchen','delivery'].includes(role)) return [];
  const next={new:'confirmed',confirmed:'preparing',preparing:'ready',ready:order.order_type==='delivery'?'out_for_delivery':'completed',out_for_delivery:'completed'}[order.order_status];
  const result=[];
  if (next && (order.payment_method!=='razorpay' || order.payment_status==='paid') &&
      (role!=='kitchen'||['confirmed','preparing','ready'].includes(next)) &&
      (role!=='delivery'||(order.order_type==='delivery'&&['out_for_delivery','completed'].includes(next)))) result.push(next);
  if (['admin','staff'].includes(role)&&!['completed','cancelled'].includes(order.order_status)) result.push('cancelled');
  return result;
}
export function canViewOrder(order,userId,role,guestAuthorized=false) {
  if (userId && order.user_id===userId) return true;
  if (guestAuthorized) return true;
  if (['admin','staff'].includes(role)) return true;
  if (role==='kitchen') return ['new','confirmed','preparing','ready'].includes(order.order_status) && (order.payment_method!=='razorpay'||order.payment_status==='paid');
  return role==='delivery'&&order.order_type==='delivery'&&['ready','out_for_delivery','completed'].includes(order.order_status);
}
export function publicOrder(order,role='customer') {
  const {request_id,user_id,...safe}=order;
  if (role==='kitchen') { delete safe.phone; delete safe.delivery_address; delete safe.customer_name; }
  return safe;
}
