import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBillingSettings, placeOfSupply, financialYear, billingRange, invoicesCSV, needsCreditNote, creditedTotal, renderInvoice, renderCreditNote, guestToken, docTitle } from '../billing.js';

const invoice = {
  id: 'i1', order_id: 'abcdef12-0000-4000-8000-000000000000', invoice_no: 'NF/26-27/00001', issued_at: '2026-10-09T08:00:00Z', payment_method: 'cash',
  seller: { legal_name: 'Newform <Restaurant>', address: 'Kalpetta\nWayanad', gstin: '32ABCDE1234F1Z5', sac: '996331', footer: '' },
  buyer: { name: '=HYPERLINK("x")', phone: '9999999999', order_type: 'dine_in', table: '4' },
  lines: [{ name: 'Mandhi', portion: 'half', quantity: 2, price: 380.5 }],
  taxable: 761, cgst: 19.03, sgst: 19.03, delivery_fee: 0, round_off: -0.06, total: 799, credit_notes: [],
};

test('billing settings are cleaned and validated with owner-friendly messages', () => {
  const row = normalizeBillingSettings({ enabled: true, legal_name: '  Newform  ', address: 'Kalpetta ', gstin: ' 32abcde1234f1z5 ', fssai: '1122 3344 5566 77', prefix: 'nf', sac: '', phone: '' });
  assert.deepEqual(row, { enabled: true, legal_name: 'Newform', address: 'Kalpetta', phone: null, gstin: '32ABCDE1234F1Z5', fssai: '11223344556677', sac: '996331', prefix: 'NF', footer: '' });
  assert.equal(normalizeBillingSettings({}).enabled, false);
  assert.throws(() => normalizeBillingSettings({ gstin: '32ABCDE1234' }), /15-character/);
  assert.throws(() => normalizeBillingSettings({ fssai: '123' }), /14 digits/);
  assert.throws(() => normalizeBillingSettings({ prefix: 'N/' }), /prefix/);
  assert.throws(() => normalizeBillingSettings({ enabled: true, legal_name: 'X' }), /name and address/);
  assert.equal(placeOfSupply('32ABCDE1234F1Z5'), 'Kerala (32)');
  assert.equal(placeOfSupply(null), null);
});

test('financial years and preset ranges follow the April–March calendar', () => {
  assert.equal(financialYear('2026-10-09'), '26-27');
  assert.equal(financialYear('2027-03-31'), '26-27');
  assert.equal(financialYear('2027-04-01'), '27-28');
  assert.equal(financialYear('2099-06-01'), '99-00');
  assert.deepEqual(billingRange('month', '2026-10-09'), { from: '2026-10-01', to: '2026-10-09' });
  assert.deepEqual(billingRange('last', '2027-01-15'), { from: '2026-12-01', to: '2026-12-31' });
  assert.deepEqual(billingRange('last', '2028-03-02'), { from: '2028-02-01', to: '2028-02-29' });
  assert.deepEqual(billingRange('fy', '2027-02-10'), { from: '2026-04-01', to: '2027-02-10' });
});

test('CSV export quotes text and neutralises spreadsheet formulas', () => {
  const csv = invoicesCSV([{ ...invoice, buyer: { ...invoice.buyer, name: '=HYPERLINK("x")' }, credit_notes: [{ total: 99.9 }] }]);
  const [header, row] = csv.trim().split('\r\n');
  assert.match(header, /^Invoice no,Date \(IST\),Customer/);
  assert.match(row, /^NF\/26-27\/00001,/);
  assert.ok(row.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(row.endsWith(',761.00,19.03,19.03,0.00,-0.06,799.00,99.90'));
});

test('refunded invoices need a credit note until fully credited', () => {
  assert.equal(needsCreditNote({ ...invoice, order: { payment_status: 'paid' } }), false);
  assert.equal(needsCreditNote({ ...invoice, order: { payment_status: 'refunded' } }), true);
  assert.equal(needsCreditNote({ ...invoice, order: { payment_status: 'refunded' }, credit_notes: [{ total: 99.9 }, { total: '699.10' }] }), false);
  assert.equal(creditedTotal({ credit_notes: [{ total: '1.5' }, { total: 2 }] }), 3.5);
});

test('invoice and credit note render escaped, with GST split and place of supply', () => {
  const html = renderInvoice(invoice);
  assert.ok(html.includes('Newform &lt;Restaurant&gt;'));
  assert.ok(!html.includes('<Restaurant>'));
  assert.ok(html.includes('Tax invoice') && html.includes('NF/26-27/00001') && html.includes('Kerala (32)'));
  assert.ok(html.includes('CGST @ 2.5%') && html.includes('₹19.03') && html.includes('Round off'));
  assert.ok(!html.includes('Delivery charges')); // zero lines are left out
  assert.ok(html.includes('Table 4') && html.includes('(half)') && html.includes('₹761.00'));
  assert.equal(docTitle({ gstin: null }), 'Bill');
  const note = renderCreditNote({ note_no: 'NFC/26-27/00001', issued_at: '2026-10-10T08:00:00Z', reason: 'Missing <item>', taxable: 95.14, cgst: 2.38, sgst: 2.38, other: 0, total: 99.9 }, invoice);
  assert.ok(note.includes('Credit note') && note.includes('Against invoice') && note.includes('Missing &lt;item&gt;'));
});

test('guest invoice access reads the tracking key already stored on the device', () => {
  const storage = { getItem: () => JSON.stringify([{ id: 'o1', token: 't1' }]) };
  assert.equal(guestToken('o1', storage), 't1');
  assert.equal(guestToken('o2', storage), undefined);
  assert.equal(guestToken('o1', { getItem: () => '{bad json' }), undefined);
});
