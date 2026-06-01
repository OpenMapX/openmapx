"use client";

/**
 * Tiny IndexedDB key-value store. localStorage tops out around 5–10 MB and is
 * shared across the whole app; IndexedDB gives offline datasets (the persisted
 * query cache, the saved-places mirror, future per-area POI indexes) far more
 * headroom and stores structured values without JSON round-trips. One database,
 * one object store, string keys → arbitrary structured-cloneable values.
 */

const DB_NAME = "openmapx";
const STORE = "kv";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
  return dbPromise;
}

function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

export function idbSupported(): boolean {
  return typeof indexedDB !== "undefined";
}

export async function idbGet<T = unknown>(key: string): Promise<T | undefined> {
  if (!idbSupported()) return undefined;
  try {
    return (await withStore<T>("readonly", (s) => s.get(key))) ?? undefined;
  } catch {
    return undefined;
  }
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  if (!idbSupported()) return;
  try {
    await withStore("readwrite", (s) => s.put(value as never, key));
  } catch {
    // best-effort — quota errors etc. must never break the caller
  }
}

export async function idbDelete(key: string): Promise<void> {
  if (!idbSupported()) return;
  try {
    await withStore("readwrite", (s) => s.delete(key));
  } catch {
    // best-effort
  }
}
