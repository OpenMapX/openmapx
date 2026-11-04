import { getRandomValues } from "expo-crypto";

/**
 * Gives the JavaScript runtime the Web Crypto CSPRNG it lacks.
 *
 * Hermes has no `crypto` global, and both the bridge's per-document nonce and
 * the navigation session id are minted from `crypto.getRandomValues`. Without
 * this the shell fails on its first render. Expo Crypto reads the platform
 * generator (`SecRandomCopyBytes`, `SecureRandom`), so nothing here weakens the
 * "cryptographic randomness or nothing" rule the channel enforces.
 *
 * Only `getRandomValues` is installed. A runtime that already has one keeps it.
 */
export function installCrypto(scope: { crypto?: unknown } = globalThis): void {
  const existing = scope.crypto as { getRandomValues?: unknown } | undefined;
  if (existing && typeof existing.getRandomValues === "function") return;

  const fill = <T extends ArrayBufferView | null>(array: T): T => {
    if (
      !(
        array instanceof Int8Array ||
        array instanceof Uint8Array ||
        array instanceof Uint8ClampedArray ||
        array instanceof Int16Array ||
        array instanceof Uint16Array ||
        array instanceof Int32Array ||
        array instanceof Uint32Array
      )
    ) {
      throw new TypeError("getRandomValues requires an integer typed array");
    }
    getRandomValues(array);
    return array;
  };

  if (existing && typeof existing === "object") {
    Object.defineProperty(existing, "getRandomValues", { configurable: true, value: fill });
    return;
  }
  Object.defineProperty(scope, "crypto", {
    configurable: true,
    value: { getRandomValues: fill },
  });
}

installCrypto();
