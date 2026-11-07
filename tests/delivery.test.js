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
test('Delivery range and price per km come from the admin settings',()=>{
 assert.equal(deliveryFee(3400,{maxKm:8,perKm:25}),85);
 assert.equal(deliveryFee(7500,{maxKm:8,perKm:25}),188); // 187.5 rounds up
 assert.equal(deliveryFee(2000,{maxKm:8,perKm:0}),0);
 assert.throws(()=>deliveryFee(8001,{maxKm:8,perKm:25}),/within 8 km/);
 assert.equal(deliveryFee(5500,{maxKm:5.5,perKm:12.5}),69); // 68.75
});
test('Routing cannot silently fall back to free delivery when missing configuration',async()=>{
 await assert.rejects(roadQuote({lat:11,lng:76},''),/not configured/);
});

test('address search accepts area names, exact places first, nearest first, no duplicates',async()=>{
 const {rankMatches}=await import('../supabase/functions/_shared/delivery.js');
 const f=(label,layer,lng,lat)=>({properties:{label,layer},geometry:{coordinates:[lng,lat]}});
 const out=rankMatches([
  f('Hibernest Kalpetta','venue',76.0825,11.6306),
  f('Kalpetta Bus Stand','venue',76.0843,11.6055),
  f('Mandayapuram, Kalpetta','neighbourhood',76.0830,11.6120),
  f('Kalpetta Bus Stand','venue',76.0843,11.6055),
  f('Far away town','locality',76.6,11.9),
  f('Some county','county',76.08,11.61),
 ]);
 assert.deepEqual(out.map(m=>m.label),['Kalpetta Bus Stand','Hibernest Kalpetta','Mandayapuram, Kalpetta (area, approximate)']);
 assert.equal(out[2].approximate,true);assert.equal(out[0].approximate,false);
 assert.throws(()=>rankMatches([f('Far away town','locality',76.6,11.9)]),/Locate/);
});
