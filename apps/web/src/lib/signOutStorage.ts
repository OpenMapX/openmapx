import { type BrowserStorageKey, STORAGE_KEYS } from "@openmapx/core/storage-keys";
import type { MangroveSignerStorageKeys } from "@openmapx/mangrove-react";

/** The sessionStorage keys the Mangrove signer keeps its tab state under. */
export const MANGROVE_SIGNER_STORAGE_KEYS: MangroveSignerStorageKeys = {
  session: STORAGE_KEYS.mangroveSignerSession.key,
  pendingLogin: STORAGE_KEYS.mangrovePendingLogin.key,
  mode: STORAGE_KEYS.mangroveMode.key,
};

const SIGN_OUT_WEB_STORAGE_KEYS: readonly BrowserStorageKey[] = Object.values(STORAGE_KEYS).filter(
  (entry: BrowserStorageKey) => !entry.survivesSignOut && entry.storage !== "indexedDb",
);

/**
 * Remove the Web Storage keys that must not outlive the signed-in session
 * (the signer's tab credentials and the review draft). Records in IndexedDB
 * are released by their owners, which drop them once no session is confirmed.
 */
export function clearSignOutWebStorage(): void {
  if (typeof window === "undefined") return;
  for (const entry of SIGN_OUT_WEB_STORAGE_KEYS) {
    try {
      const storage =
        entry.storage === "sessionStorage" ? window.sessionStorage : window.localStorage;
      storage.removeItem(entry.key);
    } catch {
      /* An unavailable storage area holds nothing to remove. */
    }
  }
}
