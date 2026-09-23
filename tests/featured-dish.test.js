import {test} from 'node:test';
import assert from 'node:assert/strict';
import {featuredDish,featuredPrice} from '../featured-dish.js';
test('featured dish works after original menu id is removed and uses current portion prices',()=>{
 const dish={id:'new-id',name:'Alfaham Chicken Mandhi',portionType:'multi',prices:{quarter:260,half:500,full:950}};
 assert.equal(featuredDish([dish]),dish);
 assert.deepEqual(['quarter','half','full'].map(p=>featuredPrice(dish,p)),[260,500,950]);
 assert.equal(featuredDish([{...dish,available:false}]),null);
 assert.equal(featuredPrice(null,'full'),null);
 assert.equal(featuredPrice({...dish,prices:{}},'full'),null);
 assert.equal(featuredPrice({portionType:'single',price:'180'},'half'),180);
});
