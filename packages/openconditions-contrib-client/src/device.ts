import { keyIdFromJwk } from "./thumbprint";

/**
 * A device-local, pseudonymous signing identity for crowd reports. There is no
 * login and no server envelope: the key pair is minted on the device and kept
 * there (see {@link DeviceKeyStore}). Distinct from an account.
 */
export interface DeviceKey {
  /** base64url RFC 7638 thumbprint of {@link publicJwk} — the wire `keyId`. */
  keyId: string;
  /** Minimal public JWK carrying only the thumbprint members {crv, kty, x, y}. */
  publicJwk: JsonWebKey;
  /** Non-extractable ECDSA P-256 signing key. */
  privateKey: CryptoKey;
}

/** Version of the persisted {@link StoredDeviceKey} record. */
export const DEVICE_KEY_RECORD_VERSION = 1 as const;

/**
 * The persisted identity: the WebCrypto key pair itself, whose private key is
 * non-extractable, so no script on the origin can read or copy it. Only a
 * store that keeps structured-cloneable values (IndexedDB) can hold it.
 */
export interface StoredDeviceKey {
  version: typeof DEVICE_KEY_RECORD_VERSION;
  /** The RFC 7638 thumbprint of the public key, checked again on load. */
  keyId: string;
  keyPair: CryptoKeyPair;
}

/**
 * Persistence for the device identity. Not account-bound. `get` returns
 * whatever is stored; {@link loadOrCreateDeviceKey} validates it.
 */
export interface DeviceKeyStore {
  get(): Promise<unknown> | unknown;
  set(value: StoredDeviceKey): Promise<void> | void;
}

const ALGO: EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };

function minimalPublicJwk(exported: JsonWebKey): JsonWebKey {
  return { crv: "P-256", kty: "EC", x: exported.x, y: exported.y };
}

async function deviceKeyFromPair(pair: CryptoKeyPair): Promise<DeviceKey> {
  const exported = await globalThis.crypto.subtle.exportKey("jwk", pair.publicKey);
  const publicJwk = minimalPublicJwk(exported);
  return { keyId: await keyIdFromJwk(publicJwk), publicJwk, privateKey: pair.privateKey };
}

async function generateKeyPair(): Promise<CryptoKeyPair> {
  return (await globalThis.crypto.subtle.generateKey(ALGO, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
}

/**
 * Generate a fresh P-256 device identity with platform WebCrypto. The private
 * key is non-extractable; the public JWK is minimized to the thumbprint
 * members so the emitted `keyId` matches the OpenConditions verifier.
 */
export async function generateDeviceKey(): Promise<DeviceKey> {
  return deviceKeyFromPair(await generateKeyPair());
}

function isCryptoKey(value: unknown): value is CryptoKey {
  return typeof CryptoKey !== "undefined" && value instanceof CryptoKey;
}

function isEcdsaP256(key: CryptoKey): boolean {
  const algorithm = key.algorithm as Partial<EcKeyAlgorithm>;
  return algorithm.name === "ECDSA" && algorithm.namedCurve === "P-256";
}

function storedKeyPair(value: unknown): { keyId: string; keyPair: CryptoKeyPair } | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Partial<StoredDeviceKey>;
  if (record.version !== DEVICE_KEY_RECORD_VERSION || typeof record.keyId !== "string") return null;
  const pair = record.keyPair as Partial<CryptoKeyPair> | undefined;
  if (!pair || !isCryptoKey(pair.privateKey) || !isCryptoKey(pair.publicKey)) return null;
  const { privateKey, publicKey } = pair;
  if (
    privateKey.type !== "private" ||
    privateKey.extractable ||
    !privateKey.usages.includes("sign") ||
    publicKey.type !== "public" ||
    !isEcdsaP256(privateKey) ||
    !isEcdsaP256(publicKey)
  )
    return null;
  return { keyId: record.keyId, keyPair: { privateKey, publicKey } };
}

/**
 * Load the persisted device identity, or mint and persist a new one on first
 * use. A record that is not a version-1 non-extractable P-256 pair, or whose
 * stored `keyId` is not the thumbprint of its public key, is replaced.
 */
export async function loadOrCreateDeviceKey(store: DeviceKeyStore): Promise<DeviceKey> {
  const stored = storedKeyPair(await store.get());
  if (stored) {
    const key = await deviceKeyFromPair(stored.keyPair);
    if (key.keyId === stored.keyId) return key;
  }
  const keyPair = await generateKeyPair();
  const key = await deviceKeyFromPair(keyPair);
  await store.set({ version: DEVICE_KEY_RECORD_VERSION, keyId: key.keyId, keyPair });
  return key;
}

export interface IndexedDbDeviceKeyStoreOptions {
  /** The IndexedDB database that holds the identity. */
  databaseName: string;
  /** The record key the identity is stored under. */
  recordKey: string;
  /** Injected for tests; defaults to the platform's `indexedDB`. */
  indexedDB?: IDBFactory;
  /**
   * Called when another context deletes or upgrades the database. The store
   * has already closed its connection; a caller that holds the key in memory
   * drops it here, since the stored identity is going away.
   */
  onClosed?: () => void;
}

const OBJECT_STORE = "records";
const DATABASE_VERSION = 1;

/**
 * A {@link DeviceKeyStore} in IndexedDB, which keeps the `CryptoKeyPair` as a
 * structured clone without ever exposing the private key material.
 * Device-local by construction; carries no account association.
 *
 * The connection is closed as soon as another context asks to delete or
 * upgrade the database, so an open store never blocks the deletion of the
 * identity; the next read opens a fresh connection.
 */
export function indexedDbDeviceKeyStore({
  databaseName,
  recordKey,
  indexedDB = globalThis.indexedDB,
  onClosed,
}: IndexedDbDeviceKeyStoreOptions): DeviceKeyStore {
  let database: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    database ??= new Promise((resolve, reject) => {
      if (!indexedDB) {
        reject(new Error("IndexedDB is unavailable"));
        return;
      }
      const request = indexedDB.open(databaseName, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(OBJECT_STORE))
          request.result.createObjectStore(OBJECT_STORE);
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          database = null;
          onClosed?.();
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
    database.catch(() => {
      database = null;
    });
    return database;
  };
  const run = async <T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(OBJECT_STORE, mode);
      const request = operation(transaction.objectStore(OBJECT_STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  };
  return {
    get: () => run("readonly", (store) => store.get(recordKey)),
    set: async (value) => {
      await run("readwrite", (store) => store.put(value, recordKey));
    },
  };
}
