const DB_NAME = "ourchat-audio";
const STORE = "audio";
let database = null;

function openDatabase() {
  if (database) return database;
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  database = new Promise((resolve) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, 1);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return database;
}

function run(mode, action) {
  return openDatabase().then((db) => {
    if (!db) return null;
    return new Promise((resolve) => {
      let request;
      try {
        const transaction = db.transaction(STORE, mode);
        request = action(transaction.objectStore(STORE));
        transaction.onabort = () => resolve(null);
        transaction.onerror = () => resolve(null);
      } catch {
        resolve(null);
        return;
      }
      request.onsuccess = () => resolve(request.result ?? true);
      request.onerror = () => resolve(null);
    });
  });
}

export function putAudio(key, blob) {
  return run("readwrite", (store) => store.put(blob, key));
}

export function getAudio(key) {
  return run("readonly", (store) => store.get(key));
}

export function deleteAudio(key) {
  return run("readwrite", (store) => store.delete(key));
}

export function clearAudio() {
  return run("readwrite", (store) => store.clear());
}
