import test from 'node:test';
import assert from 'node:assert/strict';
import {createSpecials} from '../specials.js';
test('Specials preserves classics, adds three stable random choices, and excludes unavailable items',()=>{
 const choose=createSpecials(()=>0.5);
 const items=[{id:'m2'},{id:'v1'},{id:'m3',available:false},...Array.from({length:30},(_,i)=>({id:`new-${i}`}))];
 const chosen=choose(items);
 assert.equal(chosen.size,5);
 assert.ok(chosen.has('m2')&&chosen.has('v1'));
 assert.ok(!chosen.has('m3'));
 assert.deepEqual(choose(items),chosen);
 assert.ok(chosen.size<=20);
 assert.equal(choose([]).size,0);
});
