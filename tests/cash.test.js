import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanDenominations, denominationTotal, expectedDrawer, drawerStatus } from '../cash-policy.js';

test('denomination counts keep whole positive pieces of known values only', () => {
  assert.deepEqual(cleanDenominations({ 500: '3', 200: 0, 100: 2, 50: -1, 20: 1.5, 2000: 4, 1: 7 }), { 1: 7, 100: 2, 500: 3 });
  assert.equal(denominationTotal({ 500: 3, 100: 2, 1: 7 }), 1707);
  assert.equal(denominationTotal({}), 0);
  assert.equal(denominationTotal(null), 0);
});

test('expected drawer is the opening float plus net cash, and the difference says over or short', () => {
  assert.equal(expectedDrawer('2000', { expected_cash: 756 }), 2756);
  assert.equal(expectedDrawer('', { expected_cash: '756.5' }), 756.5);
  assert.equal(expectedDrawer(-50, {}), 0);
  assert.deepEqual(drawerStatus(2756, 2756), { difference: 0, state: 'match', amount: 0 });
  assert.deepEqual(drawerStatus(2800, 2756), { difference: 44, state: 'over', amount: 44 });
  assert.deepEqual(drawerStatus(2700.1, 2756.3), { difference: -56.2, state: 'short', amount: 56.2 });
});
