import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deliveryFee,destination,roadQuote} from '../supabase/functions/_shared/delivery.js';
test('Delivery is Rs20 per road km (exact distance, rounded up to a rupee) within 6km',()=>{
 assert.equal(deliveryFee(0),0);assert.equal(deliveryFee(1),1);
 assert.equal(deliveryFee(1000),20);assert.equal(deliveryFee(3400),68);
 assert.equal(deliveryFee(3401),69);assert.equal(deliveryFee(5000),100);assert.equal(deliveryFee(6000),120);
 assert.throws(()=>deliveryFee(6001),/6 km/);
 assert.throws(()=>deliveryFee(NaN));assert.throws(()=>deliveryFee(-1));
 assert.deepEqual(destination({lat:11,lng:76}),[76,11]);
 assert.throws(()=>destination({lat:'11',lng:76}));assert.throws(()=>destination({lat:100,lng:76}));
});
test('Routing cannot silently fall back to free delivery when missing configuration',async()=>{
 await assert.rejects(roadQuote({lat:11,lng:76},''),/not configured/);
});
