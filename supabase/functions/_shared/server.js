import {createClient} from 'npm:@supabase/supabase-js@2.112.4';
export const db=createClient(Deno.env.get('SUPABASE_URL'),Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}});
export function checked(result) { if(result.error) throw new Error(result.error.message); return result.data; }
export const rpc=async(name,args)=>checked(await db.rpc(name,args));
export const paymentConfigured=()=> Boolean(Deno.env.get('RAZORPAY_KEY_ID')&&Deno.env.get('RAZORPAY_KEY_SECRET')&&Deno.env.get('RAZORPAY_WEBHOOK_SECRET'));
export async function razorpay(path,options={}) {
  if(!paymentConfigured()) throw new Error('Online payment setup is pending. Choose cash or WhatsApp.');
  const response=await fetch('https://api.razorpay.com/v1/'+path,{...options,headers:{Authorization:'Basic '+btoa(Deno.env.get('RAZORPAY_KEY_ID')+':'+Deno.env.get('RAZORPAY_KEY_SECRET')),'Content-Type':'application/json'},signal:AbortSignal.timeout(15000)});
  if(!response.ok) throw new Error('Payment provider unavailable. Please retry or contact the restaurant.');
  return response.json();
}
