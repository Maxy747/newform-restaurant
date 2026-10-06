import {test} from 'node:test';
import assert from 'node:assert/strict';
import {featuredDish,featuredPrice,createFeaturedSelector} from '../featured-dish.js';
test('featured starts with chicken, changes on reload, stays stable, and skips stockouts',()=>{
 const items=[{id:'ch',name:'Chicken Mandi'},{id:'beef',name:'Beef Fry'},{id:'other',name:'Not special'}];
 const values=new Map();
 const options={specials:()=>new Set(['ch','beef']),storage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)},random:()=>0};
 const first=createFeaturedSelector(options);
 assert.equal(first(items).id,'ch');
 assert.equal(first(items).id,'ch');
 const refreshed=createFeaturedSelector(options);
 assert.equal(refreshed(items).id,'beef');
 assert.equal(refreshed(items).id,'beef');
 assert.equal(refreshed(items.map(i=>({...i,available:i.id!=='beef'}))).id,'ch');
 assert.equal(refreshed(items.map(i=>({...i,available:false}))),null);
});
test('featured dish works after original menu id is removed and uses current portion prices',()=>{
 const dish={id:'new-id',name:'Alfaham Chicken Mandhi',portionType:'multi',prices:{quarter:260,half:500,full:950}};
 assert.equal(featuredDish([dish]),dish);
 assert.deepEqual(['quarter','half','full'].map(p=>featuredPrice(dish,p)),[260,500,950]);
 assert.equal(featuredDish([{...dish,available:false}]),null);
 assert.equal(featuredPrice(null,'full'),null);
 assert.equal(featuredPrice({...dish,prices:{}},'full'),null);
 assert.equal(featuredPrice({portionType:'single',price:'180'},'half'),180);
});
