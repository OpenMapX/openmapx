/** Archive path of the integration's backend module. */
export const BACKEND_ENTRY_PATH = "dist/backend/index.mjs";
/** Archive path of the integration's browser module. */
export const WEB_ENTRY_PATH = "dist/web/index.mjs";
/** Archive path of one database migration; the capture is its sequence number. */
export const MIGRATION_FILE_PATTERN = /^migrations\/(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
/** File name of one database migration; the capture is its sequence number. */
export const MIGRATION_NAME_PATTERN = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
/** Archive path of one locale's message catalogue. */
export const MESSAGE_FILE_PATTERN = /^messages\/[a-z0-9-]{2,35}\.json$/;
export const ASSET_PATH_PREFIX = "assets/";
/** One directory or file name below `assets/`; a leading dot is refused so nothing is hidden. */
export const ASSET_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * Per-kind file counts and per-file sizes. Together with the fixed metadata
 * files they keep one archive's listing within what an installed record may
 * hold.
 */
export const INTEGRATION_ARCHIVE_LIMITS = {
  backendEntryBytes: 32 * 1024 * 1024,
  webEntryBytes: 16 * 1024 * 1024,
  migrationFiles: 200,
  migrationBytes: 1024 * 1024,
  messageFiles: 100,
  messageBytes: 256 * 1024,
  assetFiles: 512,
  assetBytes: 8 * 1024 * 1024,
  assetDepth: 8,
} as const;

export type IntegrationArchiveEntryKind =
  | "backend-entry"
  | "web-entry"
  | "migration"
  | "message"
  | "asset";

/** The kind of an archive entry, or `null` when the path is not part of the layout. */
export function integrationArchiveEntryKind(path: string): IntegrationArchiveEntryKind | null {
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".."))
    return null;
  if (path === BACKEND_ENTRY_PATH) return "backend-entry";
  if (path === WEB_ENTRY_PATH) return "web-entry";
  if (MIGRATION_FILE_PATTERN.test(path)) return "migration";
  if (MESSAGE_FILE_PATTERN.test(path)) return "message";
  if (path.startsWith(ASSET_PATH_PREFIX)) {
    const below = segments.slice(1);
    if (
      below.length >= 1 &&
      below.length <= INTEGRATION_ARCHIVE_LIMITS.assetDepth &&
      below.every((segment) => ASSET_PATH_SEGMENT_PATTERN.test(segment))
    )
      return "asset";
  }
  return null;
}

/**
 * Why a set of migration file names cannot be applied in order, or `null`
 * when they are numbered 0001, 0002, … without a gap or a repeat.
 */
export function migrationSequenceProblem(names: readonly string[]): string | null {
  const sorted = [...names].sort();
  for (const [index, name] of sorted.entries()) {
    const match = MIGRATION_NAME_PATTERN.exec(name);
    if (!match) return `"${name}" is not a migration file name`;
    const expected = String(index + 1).padStart(4, "0");
    if (match[1] !== expected)
      return `migrations must be numbered from 0001 without gaps: expected ${expected}, found ${match[1]}`;
  }
  return null;
}
