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
      sessionStorage.removeItem(key);
      return null;
    }
    return value;
  } catch {
    sessionStorage.removeItem(key);
    return null;
  }
}
export function retainCredentialPreview(key: string, value: CredentialImportPreview) {
  sessionStorage.setItem(key, JSON.stringify(credentialImportPreviewSchema.parse(value)));
}
