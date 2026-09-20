// Read-only/invalid-request production checks. Never creates orders or charges.
import assert from 'node:assert/strict';
const base='https://crlivalipmeypovsubca.supabase.co/functions/v1/';
async function call(action,extra={},headers={}) {
 const response=await fetch(base+'oms-api',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({action,...extra})});
 return {status:response.status,body:await response.json()};
}
const config=await call('config');assert.equal(config.status,200);assert.equal(config.body.role,'customer');
const list=await call('list');assert.equal(list.status,200);assert.deepEqual(list.body.orders,[]);
const detail=await call('detail',{id:'00000000-0000-4000-8000-000000000000',token:'a'.repeat(64)});assert.equal(detail.status,400);assert.match(detail.body.error,/not found|access denied/);
const forged=await call('analytics',{start:'2026-09-20',end:'2026-09-21'});assert.equal(forged.status,403);
const invalidJWT=await call('config',{}, {Authorization:'Bearer invalid-user-token'});assert.equal(invalidJWT.status,401);
const webhook=await fetch(base+'razorpay-webhook',{method:'POST',body:'{}'});assert.equal(webhook.status,401);
console.log('PASS: guest privacy, missing-order access, staff authorization, invalid JWT, unsigned webhook.');
console.log('Online payment configured:',config.body.payments,'Test mode:',config.body.testMode);
