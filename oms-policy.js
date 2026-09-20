export { nextStatuses } from './supabase/functions/_shared/security.js';
export const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const money=value=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:2}).format(Number(value)||0);
export const statusLabel=value=>({new:'Order placed',confirmed:'Confirmed',preparing:'Cooking',ready:'Ready',out_for_delivery:'Out for delivery',completed:'Completed',cancelled:'Cancelled',awaiting_payment:'Awaiting payment',not_required:'Arrange with restaurant'}[value]||String(value||'').replaceAll('_',' '));
export function indiaDayRange(day) {
  const start=new Date(day+'T00:00:00+05:30');
  return {start:start.toISOString(),end:new Date(+start+86400000).toISOString()};
}
export function hasDeliveryDetails(profile,kind='delivery') {
  return Boolean(profile?.full_name?.trim()&&profile?.phone?.trim()&&(kind!=='delivery'||profile?.default_address?.trim()));
}
