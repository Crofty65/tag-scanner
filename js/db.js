// Tiny IndexedDB wrapper. Two stores:
//   kv    — settings, session, recents, tab cache, summary (key → value)
//   scans — one record per scan, keyPath "id"; holds the image Blob until the row is saved.

const DB_NAME = 'price-tag-scanner';
const VERSION = 1;
let dbp;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('scans')) db.createObjectStore('scans', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const kvGet = key => tx('kv', 'readonly', s => s.get(key));
export const kvSet = (key, value) => tx('kv', 'readwrite', s => s.put(value, key));

export const scansAll = () => tx('scans', 'readonly', s => s.getAll());
export const scanPut = scan => tx('scans', 'readwrite', s => s.put(scan));
export const scanDelete = id => tx('scans', 'readwrite', s => s.delete(id));
