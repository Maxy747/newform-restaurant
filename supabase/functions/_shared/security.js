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
// Drivers only act on deliveries assigned to them (pass the signed-in user's id).
export function nextStatuses(order,role,userId=null) {
  if (!['admin','staff','kitchen','delivery'].includes(role)) return [];
  if (role==='delivery'&&(!userId||order.assigned_driver!==userId)) return [];
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
  if (role!=='delivery'||order.order_type!=='delivery') return false;
  // Unassigned ready orders are visible to every driver so one of them can claim it.
  if (!order.assigned_driver) return order.order_status==='ready';
  return Boolean(userId)&&order.assigned_driver===userId&&['ready','out_for_delivery','completed'].includes(order.order_status);
}
export function canClaim(order,role,userId) {
  return role==='delivery'&&Boolean(userId)&&order.order_type==='delivery'&&order.order_status==='ready'&&!order.assigned_driver;
}
export function publicOrder(order,role='customer') {
  const {request_id,user_id,...safe}=order;
  // Customers and the kitchen only see the driver's name, never their account id or phone.
  if (!['admin','staff','delivery'].includes(role)) { delete safe.assigned_driver; if (safe.driver) safe.driver={display_name:safe.driver.display_name}; }
  if (role==='kitchen') { delete safe.phone; delete safe.delivery_address; delete safe.customer_name; delete safe.delivery_latitude; delete safe.delivery_longitude; }
  return safe;
}
