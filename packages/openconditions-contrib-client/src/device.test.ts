import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import {
  DEVICE_KEY_RECORD_VERSION,
  type DeviceKeyStore,
  generateDeviceKey,
  indexedDbDeviceKeyStore,
  loadOrCreateDeviceKey,
  type StoredDeviceKey,
} from "./device.js";
import { keyIdFromJwk } from "./thumbprint.js";

function memoryStore(initial?: unknown): DeviceKeyStore & { value: unknown } {
  const store = {
    value: initial,
    get: () => store.value,
    set: (value: StoredDeviceKey) => {
      store.value = value;
    },
  };
  return store;
}

describe("device key", () => {
  it("is a non-extractable P-256 signing key with its RFC 7638 key id", async () => {
    const key = await generateDeviceKey();
    expect(key.privateKey.extractable).toBe(false);
    expect(key.privateKey.usages).toEqual(["sign"]);
    expect(key.publicJwk).toEqual({
      crv: "P-256",
      kty: "EC",
      x: key.publicJwk.x,
      y: key.publicJwk.y,
    });
    expect(key.keyId).toBe(await keyIdFromJwk(key.publicJwk));
    await expect(globalThis.crypto.subtle.exportKey("jwk", key.privateKey)).rejects.toThrow();
  });

  it("stores a version-1 record holding the key pair and reloads the same identity", async () => {
    const store = memoryStore();
    const first = await loadOrCreateDeviceKey(store);
    const record = store.value as StoredDeviceKey;
    expect(record.version).toBe(DEVICE_KEY_RECORD_VERSION);
    expect(record.keyId).toBe(first.keyId);
    expect(record.keyPair.privateKey.extractable).toBe(false);
    expect(Object.keys(record).sort()).toEqual(["keyId", "keyPair", "version"]);

    const second = await loadOrCreateDeviceKey(store);
    expect(second.keyId).toBe(first.keyId);
    expect(second.privateKey).toBe(record.keyPair.privateKey);
  });

  it.each<[string, (record: StoredDeviceKey) => unknown]>([
    ["another version", (record) => ({ ...record, version: 2 })],
    ["a key id that is not the public key's thumbprint", (record) => ({ ...record, keyId: "x" })],
    ["no key pair", (record) => ({ version: record.version, keyId: record.keyId })],
    ["a private JWK instead of a key pair", (record) => ({ ...record, keyPair: { d: "secret" } })],
  ])("replaces a stored record with %s", async (_label, corrupt) => {
    const store = memoryStore();
    const original = await loadOrCreateDeviceKey(store);
    store.value = corrupt(store.value as StoredDeviceKey);
    const replaced = await loadOrCreateDeviceKey(store);
    expect(replaced.keyId).not.toBe(original.keyId);
    expect((store.value as StoredDeviceKey).keyId).toBe(replaced.keyId);
  });

  it("replaces an extractable stored key pair", async () => {
    const extractable = (await globalThis.crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const publicJwk = await globalThis.crypto.subtle.exportKey("jwk", extractable.publicKey);
    const keyId = await keyIdFromJwk({
      crv: "P-256",
      kty: "EC",
      x: publicJwk.x,
      y: publicJwk.y,
    });
    const store = memoryStore({ version: 1, keyId, keyPair: extractable });
    const key = await loadOrCreateDeviceKey(store);
    expect(key.keyId).not.toBe(keyId);
    expect(key.privateKey.extractable).toBe(false);
  });
});

describe("IndexedDB device key store", () => {
  it("keeps the key pair across store instances of one database", async () => {
    const indexedDB = new IDBFactory();
    const options = { databaseName: "openmapx:crowd", recordKey: "openmapx:crowd:device-key" };
    const first = await loadOrCreateDeviceKey(indexedDbDeviceKeyStore({ ...options, indexedDB }));
    const second = await loadOrCreateDeviceKey(indexedDbDeviceKeyStore({ ...options, indexedDB }));
    expect(second.keyId).toBe(first.keyId);
    expect(second.privateKey.extractable).toBe(false);
  });

  it("closes its connection so the database can be deleted while it is open", async () => {
    const indexedDB = new IDBFactory();
    const options = { databaseName: "openmapx:crowd", recordKey: "openmapx:crowd:device-key" };
    let closed = 0;
    const store = indexedDbDeviceKeyStore({ ...options, indexedDB, onClosed: () => closed++ });
    const first = await loadOrCreateDeviceKey(store);

    const blocked = await new Promise<boolean>((resolve, reject) => {
      let wasBlocked = false;
      const request = indexedDB.deleteDatabase(options.databaseName);
      request.onblocked = () => {
        wasBlocked = true;
      };
      request.onsuccess = () => resolve(wasBlocked);
      request.onerror = () => reject(request.error);
    });

    expect(blocked).toBe(false);
    expect(closed).toBe(1);
    expect(await store.get()).toBeUndefined();
    const second = await loadOrCreateDeviceKey(store);
    expect(second.keyId).not.toBe(first.keyId);
  });

  it("rejects when IndexedDB is unavailable", async () => {
    const store = indexedDbDeviceKeyStore({
      databaseName: "openmapx:crowd",
      recordKey: "openmapx:crowd:device-key",
      indexedDB: undefined as unknown as IDBFactory,
    });
    await expect(Promise.resolve(store.get())).rejects.toThrow(/IndexedDB/);
  });
});
