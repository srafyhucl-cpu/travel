/**
 * 极简 IndexedDB 封装：离线优先的基础设施。
 * 存三类东西：行程快照、照片二进制、待同步的写操作队列。
 */

const DB_NAME = 'travel-companion';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots');
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
      if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'seq', autoIncrement: true });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let result;
        try {
          result = fn(s);
        } catch (e) {
          reject(e);
          return;
        }
        t.oncomplete = () => resolve(result?.result ?? result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

export const idb = {
  async get(store, key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(store, 'readonly').objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async set(store, key, value) {
    return tx(store, 'readwrite', (s) => s.put(value, key));
  },
  async del(store, key) {
    return tx(store, 'readwrite', (s) => s.delete(key));
  },
  async all(store) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(store, 'readonly').objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },
  async clear(store) {
    return tx(store, 'readwrite', (s) => s.clear());
  },
  async add(store, value) {
    return tx(store, 'readwrite', (s) => s.add(value));
  },
};

/* --------------------------- 业务封装 --------------------------- */

export const cache = {
  saveSnapshot: (tripId, data) => idb.set('snapshots', tripId, { data, savedAt: Date.now() }),
  loadSnapshot: async (tripId) => {
    const row = await idb.get('snapshots', tripId);
    return row?.data ?? null;
  },
  dropSnapshot: (tripId) => idb.del('snapshots', tripId),

  saveMeta: (key, value) => idb.set('meta', key, value),
  loadMeta: (key) => idb.get('meta', key),
  dropMeta: (key) => idb.del('meta', key),

  saveBlob: (photoId, blob) => idb.set('blobs', photoId, blob),
  loadBlob: (photoId) => idb.get('blobs', photoId),
  dropBlob: (photoId) => idb.del('blobs', photoId),
};

/* --------------------------- 离线写队列 --------------------------- */

export const queue = {
  async list() {
    return (await idb.all('queue')).sort((a, b) => a.seq - b.seq);
  },
  async push(item) {
    return idb.add('queue', { ...item, queuedAt: Date.now() });
  },
  async remove(seq) {
    return idb.del('queue', seq);
  },
  async size() {
    return (await idb.all('queue')).length;
  },
  async clear() {
    return idb.clear('queue');
  },
};
