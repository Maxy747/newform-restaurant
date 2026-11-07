import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutbox, readyEntries, applyChanges } from '../outbox.js';
import { memoryStore } from '../offline-store.js';
import { isOfflineError, OfflineError, createOmsApi } from '../oms-client.js';
import { alreadyReached } from '../admin-policy.js';
import { offlineReceiptHTML, provisionalNumber, ticketTotals } from '../counter-policy.js';
import { buildGroups, entryFiles, htmlAssets, renderServiceWorker } from '../offline-manifest.js';

const noLock = (_name, fn) => fn();
const offline = () => new OfflineError();

function harness({ send = async () => ({ ok: true }), clock = { t: 1_000_000 } } = {}) {
  const store = memoryStore();
  const sent = [];
  const outbox = createOutbox({ store, lock: noLock, now: () => clock.t, isOffline: isOfflineError, channelName: 'test-' + Math.random(),
    send: async entry => { const result = await send(entry); sent.push(entry); return result; } });
  return { store, outbox, sent, clock };
}

test('offline errors are told apart from server refusals', () => {
  assert.equal(isOfflineError(new OfflineError()), true);
  assert.equal(isOfflineError({ name: 'FunctionsFetchError', message: 'Failed to send a request to the Edge Function' }), true);
  assert.equal(isOfflineError(new TypeError('Failed to fetch')), true);
  assert.equal(isOfflineError({ message: 'TypeError: NetworkError when attempting to fetch resource.' }), true);
  assert.equal(isOfflineError(new Error('Invalid order transition')), false);
  assert.equal(isOfflineError(null), false);
});

test('the API caller turns a failed request into an OfflineError', async () => {
  const down = createOmsApi({ functions: { invoke: async () => ({ data: null, error: { name: 'FunctionsFetchError', message: 'Failed to send a request to the Edge Function' } }) } }, true);
  await assert.rejects(down('list'), error => error instanceof OfflineError);
  const thrown = createOmsApi({ functions: { invoke: async () => { throw new TypeError('Failed to fetch'); } } }, true);
  await assert.rejects(thrown('list'), error => error instanceof OfflineError);
  const refused = createOmsApi({ functions: { invoke: async () => ({ data: { error: 'Invalid order transition' }, error: null }) } }, true);
  await assert.rejects(refused('transition'), error => !isOfflineError(error) && /Invalid order transition/.test(error.message));
});

test('steps for one order go out in order, one at a time, after their undo window', () => {
  const entries = [
    { id: 'a', seq: 1, userId: 'u', kind: 'change', orderId: 'o1', state: 'queued', holdUntil: 0 },
    { id: 'b', seq: 2, userId: 'u', kind: 'change', orderId: 'o1', state: 'queued', holdUntil: 0 },
    { id: 'c', seq: 3, userId: 'u', kind: 'change', orderId: 'o2', state: 'queued', holdUntil: 500 },
    { id: 'd', seq: 4, userId: 'u', kind: 'change', orderId: 'o2', state: 'queued', holdUntil: 0 },
    { id: 'e', seq: 5, userId: 'u', kind: 'counter', state: 'queued', holdUntil: 0 },
    { id: 'f', seq: 6, userId: 'other', kind: 'counter', state: 'queued', holdUntil: 0 },
    { id: 'g', seq: 7, userId: 'u', kind: 'change', orderId: 'o3', state: 'failed', holdUntil: 0 },
    { id: 'h', seq: 8, userId: 'u', kind: 'change', orderId: 'o3', state: 'queued', holdUntil: 0 },
  ];
  // o2 waits for its undoable step; o3 waits behind its refused step; other users' entries never go.
  assert.deepEqual(readyEntries(entries, 'u', 100).map(entry => entry.id), ['a', 'e']);
  assert.deepEqual(readyEntries(entries, 'u', 1000).map(entry => entry.id), ['a', 'c', 'e']);
});

test('unsent steps show on the board as if they had landed', () => {
  const order = { id: 'o1', order_status: 'confirmed', payment_status: 'pending' };
  const entries = [
    { seq: 2, kind: 'change', orderId: 'o1', state: 'queued', status: 'ready' },
    { seq: 1, kind: 'change', orderId: 'o1', state: 'queued', status: 'preparing' },
    { seq: 3, kind: 'change', orderId: 'o1', state: 'failed', status: 'completed', cash: true },
    { seq: 4, kind: 'change', orderId: 'o2', state: 'queued', status: 'cancelled' },
  ];
  assert.deepEqual(applyChanges(order, entries), { id: 'o1', order_status: 'ready', payment_status: 'pending' });
  assert.deepEqual(applyChanges(order, [{ seq: 1, kind: 'change', orderId: 'o1', state: 'queued', cash: true }]).payment_status, 'paid');
});

test('the outbox survives a reload, sends when back online and keeps refused entries for staff', async () => {
  let online = false;
  const { store, outbox, sent, clock } = harness({
    send: async entry => {
      if (!online) throw offline();
      if (entry.status === 'cancelled') throw new Error('Invalid order transition');
      return { ok: true };
    },
  });
  await outbox.add({ kind: 'change', userId: 'u', orderId: 'o1', status: 'preparing', label: '#1 → Preparing' });
  await outbox.add({ kind: 'change', userId: 'u', orderId: 'o1', status: 'ready', label: '#1 → Ready' });
  await outbox.add({ kind: 'change', userId: 'u', orderId: 'o2', status: 'cancelled', label: '#2 cancelled' });
  await outbox.add({ kind: 'counter', userId: 'u', label: 'Counter bill OFF-1', payload: { requestId: 'r1' } });

  let result = await outbox.flush('u');
  assert.deepEqual(result, { sent: 0, failed: 0, offline: true });
  assert.equal(sent.length, 0);

  // A reload: a fresh outbox reading the same device storage still has everything.
  const again = createOutbox({ store, lock: noLock, now: () => clock.t, isOffline: isOfflineError, channelName: 'reload',
    send: async entry => { if (entry.status === 'cancelled') throw new Error('Invalid order transition'); sent.push(entry); return { ok: true }; } });
  assert.equal((await again.load()).length, 4);

  online = true;
  const done = [];
  result = await again.flush('u', { onSent: entry => done.push(entry.label) });
  assert.deepEqual(result, { sent: 3, failed: 1, offline: false });
  assert.deepEqual(done, ['#1 → Preparing', '#1 → Ready', 'Counter bill OFF-1']);
  const left = again.entries();
  assert.deepEqual(left.map(entry => [entry.label, entry.state, entry.error]), [['#2 cancelled', 'failed', 'Invalid order transition']]);

  // Retry puts it back in the queue; remove lets it go.
  await again.retry(left[0].id);
  assert.equal(again.entries()[0].state, 'queued');
  await again.remove(left[0].id);
  assert.equal(again.entries().length, 0);
});

test('undo works only inside the undo window', async () => {
  const { outbox, clock } = harness();
  const entry = await outbox.add({ kind: 'change', userId: 'u', orderId: 'o1', status: 'confirmed', label: 'x', holdUntil: clock.t + 6000 });
  const later = await outbox.add({ kind: 'change', userId: 'u', orderId: 'o1', status: 'preparing', label: 'y', holdUntil: clock.t + 6000 });
  assert.ok(later.seq > entry.seq);
  assert.equal(await outbox.cancel(entry.id), true);
  clock.t += 7000;
  assert.equal(await outbox.cancel(later.id), false);
  assert.equal(outbox.entries().length, 1);
  // A held step is not sent until released.
  const held = await outbox.add({ kind: 'change', userId: 'u', orderId: 'o9', status: 'confirmed', label: 'z', holdUntil: clock.t + 6000 });
  assert.equal(readyEntries(outbox.entries(), 'u', clock.t).some(item => item.id === held.id), false);
  await outbox.release(held.id);
  assert.equal(readyEntries(outbox.entries(), 'u', clock.t).some(item => item.id === held.id), true);
});

test('a refused step that was already done elsewhere needs no retry', () => {
  const order = status => ({ order_status: status, payment_status: 'pending' });
  assert.equal(alreadyReached(order('ready'), { status: 'preparing' }), true);
  assert.equal(alreadyReached(order('preparing'), { status: 'preparing' }), true);
  assert.equal(alreadyReached(order('confirmed'), { status: 'ready' }), false);
  assert.equal(alreadyReached(order('cancelled'), { status: 'ready' }), false);
  assert.equal(alreadyReached(order('ready'), { status: 'cancelled' }), false);
  assert.equal(alreadyReached(order('completed'), { status: 'completed', cash: true }), false); // money not recorded yet
  assert.equal(alreadyReached({ order_status: 'completed', payment_status: 'paid' }, { status: 'completed', cash: true }), true);
  assert.equal(alreadyReached(null, { status: 'ready' }), false);
});

test('the offline bill says it is provisional and adds up like the server', () => {
  const lines = [{ name: 'Mandhi <Full>', portion: 'full', quantity: 2, price: 450 }, { name: 'Tea', portion: 'single', quantity: 1, price: 15 }];
  const totals = ticketTotals(lines);
  const html = offlineReceiptHTML({ provisional: provisionalNumber(3), soldAt: '2026-11-07T14:30:00Z', method: 'cash', type: 'dine_in', table: '4', name: '', cashReceived: 1000, lines, totals });
  assert.match(html, /Bill OFF-3/);
  assert.match(html, /not a tax invoice/);
  assert.match(html, /Table 4/);
  assert.match(html, /Mandhi &lt;Full&gt; \(full\)/);
  assert.match(html, /KITCHEN · OFF-3/);
  assert.match(html, /₹961\.00/); // 915 + 46 GST, as oms_create_order_base rounds it
  assert.match(html, /Change<\/td><td>₹39\.00/);
  assert.doesNotMatch(html, /<script/);
});

test('the service worker lists exactly the files each page needs', () => {
  const chunk = (fileName, name, extra = {}) => ({ type: 'chunk', fileName, name, isEntry: Boolean(name), imports: [], dynamicImports: [], viteMetadata: { importedCss: new Set(), importedAssets: new Set() }, code: fileName, ...extra });
  const bundle = {
    'assets/shared.js': chunk('assets/shared.js', null),
    'assets/main.js': chunk('assets/main.js', 'main', { imports: ['assets/shared.js'], viteMetadata: { importedCss: new Set(['assets/main.css']), importedAssets: new Set() } }),
    'assets/admin.js': chunk('assets/admin.js', 'admin', { imports: ['assets/shared.js'], dynamicImports: ['assets/lazy.js'], viteMetadata: { importedCss: new Set(['assets/admin.css']), importedAssets: new Set() } }),
    'assets/lazy.js': chunk('assets/lazy.js', null),
    'assets/invoice.js': chunk('assets/invoice.js', 'invoice'),
    'assets/logo-abc123.webp': { type: 'asset', fileName: 'assets/logo-abc123.webp', source: '' },
    'admin.html': { type: 'asset', fileName: 'admin.html', source: '<img src="./assets/logo-abc123.webp"><img src="assets/hero.webp">' },
    'index.html': { type: 'asset', fileName: 'index.html', source: '' },
  };
  assert.deepEqual(entryFiles(bundle, 'admin'), ['assets/admin.js', 'assets/admin.css', 'assets/shared.js', 'assets/lazy.js']);
  assert.deepEqual(htmlAssets(bundle['admin.html'].source), ['assets/logo-abc123.webp', 'assets/hero.webp']);
  const groups = buildGroups(bundle);
  // Public photos (not built) stay on-demand; the hashed logo is kept.
  assert.deepEqual(groups.admin, ['./admin.html', './assets/logo-abc123.webp', './assets/admin.js', './assets/admin.css', './assets/shared.js', './assets/lazy.js', './icons/favicon-64.png']);
  assert.ok(groups.site.includes('./assets/main.css') && !groups.site.includes('./assets/admin.js'));
  const sw = renderServiceWorker('const BUILD = /*__NEWFORM_BUILD__*/null;', { version: 'v1', groups });
  assert.match(sw, /^const BUILD = \{"version":"v1"/);
  assert.throws(() => renderServiceWorker('const BUILD = null;', {}), /marker/);
});
