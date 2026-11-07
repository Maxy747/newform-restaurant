// Admin outbox: changes staff make (order steps, cash received, counter sales) wait here until the
// server confirms them, so nothing is lost when the internet drops or the page reloads.
//
// Entry: { id, seq, userId, kind: 'change' | 'counter', orderId?, status?, cash?, label,
//          holdUntil, state: 'queued' | 'failed', error?, createdAt, ...kind-specific fields }
// Steps for one order go out strictly in the order staff made them; a failed or still-undoable
// step holds back the later steps for that order until staff retry or discard it.

export const OUTBOX_KEY = 'outbox';

const byOrder = (a, b) => a.seq - b.seq;

// Entries this user can send right now, oldest first.
export function readyEntries(entries, userId, now = Date.now()) {
  const blocked = new Set();
  const ready = [];
  for (const entry of [...entries].sort(byOrder)) {
    if (entry.userId !== userId) continue;
    const group = entry.kind === 'change' ? 'order:' + entry.orderId : 'entry:' + entry.id;
    const sendable = entry.state === 'queued' && !(entry.holdUntil > now);
    if (blocked.has(group)) continue;
    if (!sendable) { blocked.add(group); continue; }
    ready.push(entry);
    // One step per order per pass keeps the order of steps even if a send fails midway.
    blocked.add(group);
  }
  return ready;
}

// The order as staff expect to see it once their unsent steps land.
export function applyChanges(order, entries) {
  if (!order) return order;
  return entries
    .filter(entry => entry.kind === 'change' && entry.orderId === order.id && entry.state === 'queued')
    .sort(byOrder)
    .reduce((next, entry) => ({ ...next, ...(entry.status ? { order_status: entry.status } : {}), ...(entry.cash ? { payment_status: 'paid' } : {}) }), order);
}

const defaultLock = (name, fn) => globalThis.navigator?.locks?.request ? globalThis.navigator.locks.request(name, fn) : fn();

export function createOutbox({ store, send, isOffline, now = () => Date.now(), lock = defaultLock, onChange = () => {}, channelName = 'newform-outbox' }) {
  let entries = [];
  let seq = 0;
  let flushing = null;
  let channel = null;
  try { channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(channelName) : null; } catch { channel = null; }
  if (channel) { channel.onmessage = () => { load().catch(() => {}); }; channel.unref?.(); } // unref: never keeps Node (tests) running

  async function load() {
    entries = (await store.get(OUTBOX_KEY)) || [];
    onChange(entries);
    return entries;
  }

  // Read-modify-write under a lock so two open admin tabs never overwrite each other's entries.
  function mutate(change) {
    return lock(channelName, async () => {
      const list = (await store.get(OUTBOX_KEY)) || [];
      const result = change(list);
      await store.set(OUTBOX_KEY, list);
      entries = list;
      onChange(entries);
      channel?.postMessage('changed');
      return result;
    });
  }

  const nextSeq = () => Math.max(now() * 1000, seq + 1);

  function add(entry) {
    return mutate(list => {
      seq = Math.max(nextSeq(), ...list.map(item => item.seq + 1));
      const full = { id: crypto.randomUUID(), state: 'queued', holdUntil: 0, createdAt: new Date(now()).toISOString(), ...entry, seq };
      list.push(full);
      return full;
    });
  }

  const update = (id, patch) => mutate(list => {
    const entry = list.find(item => item.id === id);
    if (entry) Object.assign(entry, patch);
    return entry;
  });

  const remove = id => mutate(list => {
    const index = list.findIndex(item => item.id === id);
    return index >= 0 ? list.splice(index, 1)[0] : null;
  });

  // Undo: only while the entry is still inside its undo window.
  const cancel = id => mutate(list => {
    const index = list.findIndex(item => item.id === id);
    if (index < 0 || !(list[index].holdUntil > now())) return false;
    list.splice(index, 1);
    return true;
  });

  const release = id => update(id, { holdUntil: 0 });
  const retry = id => update(id, { state: 'queued', error: null, holdUntil: 0 });

  async function runFlush(userId, { onSent = () => {}, onFailed = () => {} } = {}) {
    const result = { sent: 0, failed: 0, offline: false };
    for (let guard = 0; guard < 500; guard++) {
      const list = (await store.get(OUTBOX_KEY)) || [];
      const [entry] = readyEntries(list, userId, now());
      if (!entry) break;
      let response;
      try {
        response = await send(entry);
      } catch (error) {
        if (isOffline(error)) { result.offline = true; break; }
        await update(entry.id, { state: 'failed', error: error.message || String(error) });
        result.failed++;
        onFailed(entry, error);
        continue;
      }
      await remove(entry.id);
      result.sent++;
      onSent(entry, response);
    }
    return result;
  }

  // One flush at a time per page, and one tab at a time across the device.
  function flush(userId, callbacks) {
    if (flushing) return flushing;
    flushing = lock(channelName + '-flush', () => runFlush(userId, callbacks)).finally(() => { flushing = null; });
    return flushing;
  }

  return { load, add, update, remove, cancel, release, retry, flush, entries: () => entries };
}
