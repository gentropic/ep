// Tiny Promise-wrapped IndexedDB primitives. ep uses IDB for the
// programs object store (each program is one row, keyed by name);
// snapshots travel inline on the program record. Settings, drafts, and
// the current-program pointer all stay in localStorage — small, sync,
// often-touched.
//
// All exports return Promises. Callers (storage.js) generally don't
// need to await reads directly — there's an in-memory cache layer on
// top — but writes do schedule actual IDB transactions.

const DB_NAME    = 'ep';
const DB_VERSION = 1;
const STORE_PROGRAMS = 'programs';

let _dbPromise = null;

export function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_PROGRAMS)) {
        // keyPath='name' — each program record self-identifies via its
        // `name` field, matching the localStorage shape.
        db.createObjectStore(STORE_PROGRAMS, { keyPath: 'name' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  return _dbPromise;
}

export async function idbGetAllPrograms() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROGRAMS, 'readonly');
    const store = tx.objectStore(STORE_PROGRAMS);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });
}

export async function idbPutProgram(record) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROGRAMS, 'readwrite');
    const store = tx.objectStore(STORE_PROGRAMS);
    const req = store.put(record);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

export async function idbDeleteProgram(name) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROGRAMS, 'readwrite');
    const store = tx.objectStore(STORE_PROGRAMS);
    const req = store.delete(name);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

// Bulk replace — used during the one-shot localStorage→IDB migration
// and by "reset all data" in settings. Clears the store first, then
// writes every record in `records`.
export async function idbReplaceAllPrograms(records) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROGRAMS, 'readwrite');
    const store = tx.objectStore(STORE_PROGRAMS);
    store.clear();
    for (const r of records) store.put(r);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}
