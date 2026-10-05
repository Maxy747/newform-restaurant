import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deliveryFee,destination,roadQuote} from '../supabase/functions/_shared/delivery.js';
test('Flat Rs100 delivery within 6km by road',()=>{
 assert.equal(deliveryFee(0),100);assert.equal(deliveryFee(5000),100);
 assert.equal(deliveryFee(1),100);assert.equal(deliveryFee(6000),100);
 assert.throws(()=>deliveryFee(6001),/6 km/);
 assert.throws(()=>deliveryFee(NaN));assert.throws(()=>deliveryFee(-1));
 assert.deepEqual(destination({lat:11,lng:76}),[76,11]);
 assert.throws(()=>destination({lat:'11',lng:76}));assert.throws(()=>destination({lat:100,lng:76}));
});
test('Routing cannot silently fall back to free delivery when missing configuration',async()=>{
 await assert.rejects(roadQuote({lat:11,lng:76},''),/not configured/);
});
