import { keyIdFromJwk } from "./thumbprint.js";

/**
 * A device-local, pseudonymous signing identity for crowd reports. There is no
 * login and no server envelope: the key is minted on the device and persisted
 * locally (see {@link DeviceKeyStore}). Distinct from an account.
 */
export interface DeviceKey {
  /** base64url RFC 7638 thumbprint of {@link publicJwk} — the wire `keyId`. */
  keyId: string;
  /** Minimal public JWK carrying only the thumbprint members {crv, kty, x, y}. */
  publicJwk: JsonWebKey;
  /** ECDSA P-256 signing key (the in-memory `ContributorSession` handle). */
  privateKey: CryptoKey;
}

const ALGO: EcKeyGenParams & EcKeyImportParams = {
  name: "ECDSA",
  namedCurve: "P-256",
};

function minimalPublicJwk(exported: JsonWebKey): JsonWebKey {
  return { crv: "P-256", kty: "EC", x: exported.x, y: exported.y };
}

/**
 * Generate a fresh P-256 device identity with platform WebCrypto. The private
 * key is extractable so it can be serialized to a {@link DeviceKeyStore} for
 * cross-session persistence; the public JWK is minimized to the thumbprint
 * members so the emitted `keyId` matches the OpenConditions verifier.
 */
export async function generateDeviceKey(): Promise<DeviceKey> {
  const pair = (await globalThis.crypto.subtle.generateKey(ALGO, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const exported = await globalThis.crypto.subtle.exportKey("jwk", pair.publicKey);
  const publicJwk = minimalPublicJwk(exported);
  return {
    keyId: await keyIdFromJwk(publicJwk),
    publicJwk,
    privateKey: pair.privateKey,
  };
}

/**
 * A persisted private JWK for one device identity. Only the private JWK is
 * stored; the public JWK and keyId are re-derived on load.
 */
export interface StoredDeviceKey {
  privateJwk: JsonWebKey;
}

/**
 * Pluggable persistence for the device private key. Not account-bound: a
 * localStorage- or IndexedDB-backed store keyed to the device only. Async so an
 * IndexedDB implementation fits without changing callers.
 */
export interface DeviceKeyStore {
  get(): Promise<StoredDeviceKey | null> | StoredDeviceKey | null;
  set(value: StoredDeviceKey): Promise<void> | void;
}

async function deviceKeyFromStored(stored: StoredDeviceKey): Promise<DeviceKey> {
  const privateKey = await globalThis.crypto.subtle.importKey(
    "jwk",
    stored.privateJwk,
    ALGO,
    true,
    ["sign"],
  );
  const publicJwk = minimalPublicJwk(stored.privateJwk);
  return {
    keyId: await keyIdFromJwk(publicJwk),
    publicJwk,
    privateKey,
  };
}

/**
 * Load the persisted device identity, or mint and persist a new one on first
 * use. The private key is stored as a JWK (never account-bound); the returned
 * {@link DeviceKey} carries the in-memory signing handle for the session.
 */
export async function loadOrCreateDeviceKey(store: DeviceKeyStore): Promise<DeviceKey> {
  const stored = await store.get();
  if (stored?.privateJwk) {
    return deviceKeyFromStored(stored);
  }
  const pair = (await globalThis.crypto.subtle.generateKey(ALGO, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const privateJwk = await globalThis.crypto.subtle.exportKey("jwk", pair.privateKey);
  await store.set({ privateJwk });
  const exported = await globalThis.crypto.subtle.exportKey("jwk", pair.publicKey);
  const publicJwk = minimalPublicJwk(exported);
  return {
    keyId: await keyIdFromJwk(publicJwk),
    publicJwk,
    privateKey: pair.privateKey,
  };
}

const DEFAULT_STORAGE_KEY = "openconditions.contrib.deviceKey";

/**
 * A {@link DeviceKeyStore} backed by Web Storage (localStorage by default).
 * Device-local by construction; carries no account association.
 */
export function localStorageDeviceKeyStore(
  storage: Pick<Storage, "getItem" | "setItem"> = globalThis.localStorage,
  storageKey: string = DEFAULT_STORAGE_KEY,
): DeviceKeyStore {
  return {
    get() {
      const raw = storage.getItem(storageKey);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as StoredDeviceKey;
      } catch {
        return null;
      }
    },
    set(value) {
      storage.setItem(storageKey, JSON.stringify(value));
    },
  };
}
