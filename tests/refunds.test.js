import test from 'node:test';
import assert from 'node:assert/strict';
import {providerPaymentStatus,refundPaise,refundRejected,refundStatus,matchingRefund} from '../supabase/functions/_shared/refunds.js';
import {refundSummary} from '../admin-policy.js';

test('refund amounts are whole paise and fractions of a paisa are refused',()=>{
 assert.equal(refundPaise(504),50400);
 assert.equal(refundPaise('12.34'),1234);
 assert.equal(refundPaise(0.1+0.2),30); // float noise is not a third decimal
 for(const bad of [0,-1,'',' ','abc',null,undefined,NaN,Infinity,12.345,'1e9',true]) assert.throws(()=>refundPaise(bad),/amount|decimals/,String(bad));
});

test('Razorpay payment state maps to our payment status, partial refunds included',()=>{
 assert.equal(providerPaymentStatus({status:'captured',amount_refunded:0}),'paid');
 assert.equal(providerPaymentStatus({status:'captured',amount_refunded:100}),'refunded'); // oms_apply_payment keeps it paid
 assert.equal(providerPaymentStatus({status:'refunded',amount_refunded:50400}),'refunded');
 assert.equal(providerPaymentStatus({status:'failed'}),'failed');
 assert.equal(providerPaymentStatus({status:'authorized'}),null);
 assert.equal(providerPaymentStatus(null),null);
});

test('only a 4xx refusal counts as definitely not refunded',()=>{
 assert.equal(refundRejected({status:400}),true);
 assert.equal(refundRejected({status:401}),true);
 for(const ambiguous of [{status:429},{status:500},{status:502},new Error('timeout'),null]) assert.equal(refundRejected(ambiguous),false);
 assert.equal(refundStatus({status:'processed'}),'processed');
 assert.equal(refundStatus({status:'weird'}),'pending');
});

test('an earlier attempt is found by its receipt',()=>{
 const list={entity:'collection',count:2,items:[{id:'rfnd_a',receipt:'r1'},{id:'rfnd_b',receipt:'r2'}]};
 assert.equal(matchingRefund(list,'r2').id,'rfnd_b');
 assert.equal(matchingRefund(list,'r3'),null);
 assert.equal(matchingRefund({},'r1'),null);
});

test('admin refund summary mirrors the server reservation rules',()=>{
 assert.equal(refundSummary(null,[]),null);
 const payment={amount_paise:50400,refunded_paise:0,status:'paid'};
 assert.deepEqual(refundSummary(payment,[]),{paid:50400,refunded:0,remaining:50400,confirming:false});
 const refunds=[{amount_paise:10000,status:'processed'},{amount_paise:5000,status:'requested'},{amount_paise:99999,status:'failed'}];
 assert.deepEqual(refundSummary(payment,refunds),{paid:50400,refunded:15000,remaining:35400,confirming:true});
 // A larger Dashboard refund wins over our own rows.
 assert.equal(refundSummary({...payment,refunded_paise:30000},refunds).remaining,20400);
 assert.equal(refundSummary({...payment,status:'refunded',refunded_paise:50400},[]).remaining,0);
 assert.equal(refundSummary({...payment,status:'pending'},[]).remaining,0);
});
