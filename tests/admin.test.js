import test from 'node:test';
import assert from 'node:assert/strict';
import {groupOrders,findNewOrders,ageLabel,buildMenuRow,menuPrices} from '../admin-policy.js';
import {cashOption,stepTimes,trackingCopy} from '../oms-policy.js';

const order=(id,status,minutesAgo,extra={})=>({id,order_status:status,order_type:'delivery',created_at:new Date(Date.now()-minutesAgo*60000).toISOString(),...extra});

test('board groups active orders by stage, oldest first, and keeps finished ones apart',()=>{
 const {columns,finished}=groupOrders([order('a','new',2),order('b','new',9),order('c','preparing',5),order('d','confirmed',1),order('e','ready',3),order('f','out_for_delivery',4),order('g','completed',30),order('h','awaiting_payment',1)]);
 assert.deepEqual(columns.new.map(o=>o.id),['b','a','h']);
 assert.deepEqual(columns.preparing.map(o=>o.id),['c','d']);
 assert.deepEqual(columns.ready.map(o=>o.id),['e']);
 assert.deepEqual(columns.out.map(o=>o.id),['f']);
 assert.deepEqual(finished.map(o=>o.id),['g']);
});

test('new-order alerts never fire on first load or for orders already seen',()=>{
 const seen=new Set();
 assert.deepEqual(findNewOrders(seen,[order('a','new',1)],false),[]);
 assert.deepEqual(findNewOrders(seen,[order('a','new',1),order('b','new',0),order('c','preparing',0)],true).map(o=>o.id),['b']);
 assert.deepEqual(findNewOrders(seen,[order('a','new',1),order('b','confirmed',0)],true),[]);
});

test('age labels stay short',()=>{
 const now=Date.parse('2026-10-08T12:00:00Z');
 assert.equal(ageLabel('2026-10-08T11:59:40Z',now),'just now');
 assert.equal(ageLabel('2026-10-08T11:48:00Z',now),'12 min');
 assert.equal(ageLabel('2026-10-08T09:30:00Z',now),'2 h 30 min');
});

test('dish editor validates input and produces a clean menu row',()=>{
 const base={name:'  Chicken Mandhi ',category:'mandhi',diet:'non-veg',available:true};
 assert.deepEqual(buildMenuRow({...base,portionType:'single',price:'240',tag:'',description:''}),
  {name:'Chicken Mandhi',category:'mandhi',diet:'non-veg',tag:null,description:null,portionType:'single',available:true,price:240,pricesJSON:null});
 const multi=buildMenuRow({...base,portionType:'multi',quarter:'240',half:'450',full:'850'});
 assert.deepEqual(multi.pricesJSON,{quarter:240,half:450,full:850});
 assert.equal(multi.price,null);
 assert.throws(()=>buildMenuRow({...base,name:' '}),/dish name/);
 assert.throws(()=>buildMenuRow({...base,portionType:'single',price:'0'}),/price/);
 assert.throws(()=>buildMenuRow({...base,portionType:'multi',quarter:'100',half:'',full:'300'}),/quarter, half and full/);
 assert.throws(()=>buildMenuRow({...base,diet:'vegan',portionType:'single',price:'10'}),/veg/);
 assert.deepEqual(menuPrices({portionType:'multi',pricesJSON:'{"quarter":1,"half":2,"full":3}'}),{quarter:1,half:2,full:3});
 assert.equal(menuPrices({portionType:'single',price:5}),null);
});

test('checkout cash option: COD needs the toggle and ₹799, counter payment is always open',()=>{
 assert.deepEqual(cashOption('delivery',true,799),{value:'cod',enabled:true,title:'COD',hint:'Pay on delivery'});
 assert.equal(cashOption('delivery',true,798).enabled,false);
 assert.match(cashOption('delivery',true,500).hint,/799/);
 assert.equal(cashOption('delivery',false,5000).enabled,false);
 assert.deepEqual(cashOption('takeaway',false,50),{value:'cash',enabled:true,title:'Pay at counter',hint:'Cash or UPI on pickup'});
 assert.equal(cashOption('dine_in',true,10).value,'cash');
});

test('tracker shows step times and order-type specific copy',()=>{
 const times=stepTimes([{event_type:'order.created',created_at:'t0'},{event_type:'payment.updated',created_at:'tx'},{event_type:'order.confirmed',created_at:'t1'},{event_type:'order.preparing',created_at:'t2'}]);
 assert.deepEqual([...times],[['new','t0'],['confirmed','t1'],['preparing','t2']]);
 assert.equal(trackingCopy({order_status:'ready',order_type:'takeaway'})[0],'Ready for pickup');
 assert.equal(trackingCopy({order_status:'ready',order_type:'delivery'})[0],'Packed and ready');
 assert.equal(trackingCopy({order_status:'out_for_delivery',order_type:'delivery'})[0],'On the way');
});
