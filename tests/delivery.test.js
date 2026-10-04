import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deliveryFee,destination,roadQuote} from '../supabase/functions/_shared/delivery.js';
test('Road delivery fee: first 5km free, proportional excess at Rs15/km',()=>{
 assert.equal(deliveryFee(0),0);assert.equal(deliveryFee(5000),0);
 assert.equal(deliveryFee(7000),30);assert.equal(deliveryFee(6500),22.5);
 assert.equal(deliveryFee(5001),0.02);
 assert.throws(()=>deliveryFee(NaN));assert.throws(()=>deliveryFee(-1));
 assert.deepEqual(destination({lat:11,lng:76}),[76,11]);
 assert.throws(()=>destination({lat:'11',lng:76}));assert.throws(()=>destination({lat:100,lng:76}));
});
test('Routing cannot silently fall back to free delivery when missing configuration',async()=>{
 await assert.rejects(roadQuote({lat:11,lng:76},''),/not configured/);
});
