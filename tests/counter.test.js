import test from 'node:test';
import assert from 'node:assert/strict';
import { unitPrice, addToTicket, setQuantity, ticketTotals, ticketItems, changeDue, MAX_LINES } from '../counter-policy.js';

const mandhi = { id: 'm1', name: 'Mandhi', portionType: 'multi', pricesJSON: '{"quarter":240,"half":450,"full":850}' };
const naan = { id: 'n1', name: 'Naan', portionType: 'single', price: 35 };

test('counter prices come from the same menu fields checkout uses', () => {
  assert.equal(unitPrice(mandhi, 'half'), 450);
  assert.equal(unitPrice(mandhi, 'single'), null);
  assert.equal(unitPrice(naan), 35);
  assert.equal(unitPrice(naan, 'half'), null);
  assert.equal(unitPrice({ ...naan, price: 0 }), null);
});

test('adding the same dish and portion increases quantity; portions stay separate', () => {
  let lines = addToTicket([], mandhi, 'quarter');
  lines = addToTicket(lines, mandhi, 'quarter');
  lines = addToTicket(lines, mandhi, 'full');
  lines = addToTicket(lines, naan);
  assert.deepEqual(lines.map(l => [l.key, l.quantity, l.price]), [['m1:quarter', 2, 240], ['m1:full', 1, 850], ['n1:single', 1, 35]]);
  assert.throws(() => addToTicket([], mandhi, 'single'), /no price/);
  assert.deepEqual(ticketItems(lines), [{ id: 'm1', portion: 'quarter', quantity: 2 }, { id: 'm1', portion: 'full', quantity: 1 }, { id: 'n1', portion: 'single', quantity: 1 }]);
  const full = Array.from({ length: MAX_LINES }, (_, i) => ({ key: `x${i}:single`, id: `x${i}`, portion: 'single', price: 1, quantity: 1 }));
  assert.throws(() => addToTicket(full, naan), /up to 50/);
});

test('quantities clamp to 1–99 and zero removes the line', () => {
  const lines = addToTicket([], naan);
  assert.equal(setQuantity(lines, 'n1:single', 150)[0].quantity, 99);
  assert.deepEqual(setQuantity(lines, 'n1:single', 0), []);
  assert.equal(setQuantity(lines, 'n1:single', 3.7)[0].quantity, 3);
});

test('totals round GST to the rupee like the server, and change is worked out from cash received', () => {
  const lines = setQuantity(addToTicket(addToTicket([], mandhi, 'quarter'), naan), 'n1:single', 3); // 240 + 105
  assert.deepEqual(ticketTotals(lines), { subtotal: 345, tax: 17, total: 362, count: 4 }); // 17.25 -> 17
  assert.equal(ticketTotals([{ price: 250, quantity: 1 }]).tax, 13); // 12.5 rounds up, as Postgres round() does
  assert.equal(changeDue(362, '500'), 138);
  assert.equal(changeDue(362, '300'), -62);
  assert.equal(changeDue(362, ''), null);
});
