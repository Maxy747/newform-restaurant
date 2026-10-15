import test from 'node:test';
import assert from 'node:assert/strict';
import {shopStatus,indiaMinutes,OPENS_AT,CLOSES_AT} from '../supabase/functions/_shared/hours.js';

// India is UTC+5:30 with no daylight saving, so IST times map to fixed UTC instants.
const ist = time => new Date(`2026-10-15T${time}:00+05:30`);

test('opening hours are 11 am – 11 pm India time (auto)',()=>{
 assert.equal(indiaMinutes(ist('11:00')),660);
 assert.equal(shopStatus('auto',ist('10:59')).open,false);
 assert.equal(shopStatus('auto',ist('11:00')).open,true);
 assert.equal(shopStatus('auto',ist('22:59')).open,true);
 assert.equal(shopStatus('auto',ist('23:00')).open,false);
 assert.equal(shopStatus('auto',ist('02:30')).open,false);
 assert.equal(OPENS_AT,'11 am');assert.equal(CLOSES_AT,'11 pm');
 assert.match(shopStatus('auto',ist('08:00')).button,/OPENS 11 AM/);
 assert.match(shopStatus('auto',ist('12:00')).message,/closes 11 pm/);
});

test('admin override wins over the clock',()=>{
 assert.equal(shopStatus('open',ist('02:00')).open,true);
 assert.equal(shopStatus('closed',ist('13:00')).open,false);
 assert.equal(shopStatus('closed',ist('13:00')).button,'CLOSED');
 assert.equal(shopStatus(undefined,ist('13:00')).open,true,'missing setting behaves like auto');
});
