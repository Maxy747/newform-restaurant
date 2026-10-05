import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('Place order does not automatically request geolocation',()=>{
 const source=readFileSync(new URL('../orders.js',import.meta.url),'utf8');
 const checkout=source.split('async function placeOrder()')[1].split('function closeTracking')[0];
 assert.doesNotMatch(checkout,/calculateDeliveryCharge\(|getCurrentPosition\(/);
 assert.match(checkout,/payload.customer.quote_id=deliveryQuote.id/);
 assert.match(source,/\$\('useDeliveryLocation'\)\.onclick=run\(calculateDeliveryCharge\)/);
});
