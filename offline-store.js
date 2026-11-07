// Small key-value store for the admin console's offline copy (IndexedDB, falling back to memory
// when the browser blocks storage). Values are plain JSON-safe objects.
const DB_NAME = 'newform-admin';
const STORE = 'kv';

export function memoryStore() {
  const map = new Map();
  const copy = value => value === undefined ? undefined : structuredClone(value);
  return {
    get: async key => copy(map.get(key)),
    set: async (key, value) => { map.set(key, copy(value)); },
    del: async key => { map.delete(key); },
    keys: async () => [...map.keys()],
  };
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function indexedStore(indexedDB = globalThis.indexedDB) {
  if (!indexedDB) return memoryStore();
  let opening = null;
  const open = () => opening ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Offline storage is blocked'));
  });
  const fallback = memoryStore();
  const run = async (mode, work, backup) => {
    try {
      const db = await open();
      return await request(work(db.transaction(STORE, mode).objectStore(STORE)));
    } catch { return backup(); }
  };
  return {
    get: key => run('readonly', store => store.get(key), () => fallback.get(key)),
    set: (key, value) => run('readwrite', store => store.put(value, key), () => fallback.set(key, value)).then(() => {}),
    del: key => run('readwrite', store => store.delete(key), () => fallback.del(key)).then(() => {}),
    keys: () => run('readonly', store => store.getAllKeys(), () => fallback.keys()),
  };
}
