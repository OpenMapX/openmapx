// Only locally selected categories may cross the administration error boundary.
// Dependency messages and manifest/schema values are never public diagnostics.
const messages = {
  invalid_manifest: "Invalid extension.json",
  digest_mismatch: "Extension manifest digest mismatch",
  missing_digest: "Verified extension is missing its manifest digest",
  id_mismatch: "Extension manifest id does not match catalog entry",
  version_mismatch: "Extension manifest version does not match catalog entry",
  source_storage_unavailable: "Catalog source storage is unavailable",
  invalid_source_url: "Catalog source must use a public HTTPS URL without credentials",
} as const;

export class ExtensionStoreError extends Error {
  constructor(readonly category: keyof typeof messages) {
    super(messages[category]);
  }
}
