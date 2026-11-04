import {
  type CredentialImportPreview,
  credentialImportPreviewSchema,
} from "@openmapx/core/api-contracts";
/** Public receipt metadata only. Never envelope, passphrase or credential values. */
export const credentialPreviewStorageKey = (apiUrl: string, actorId: string) =>
  `openmapx-credential-preview:${JSON.stringify([apiUrl, actorId])}`;
export function readCredentialPreview(key: string): CredentialImportPreview | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const value = credentialImportPreviewSchema.parse(JSON.parse(raw));
    if (Date.parse(value.expiresAt) <= Date.now()) {
      discardStoredPreview(key);
      return null;
    }
    return value;
  } catch {
    discardStoredPreview(key);
    return null;
  }
}
export function retainCredentialPreview(key: string, value: CredentialImportPreview) {
  const metadata = credentialImportPreviewSchema.parse(value);
  try {
    sessionStorage.setItem(key, JSON.stringify(metadata));
  } catch {
    /* Optional navigation cache. */
  }
}

/** Optional browser metadata must never prevent showing/clearing an in-memory preview. */
export function discardStoredPreview(key: string) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* Storage can be unavailable. */
  }
}
