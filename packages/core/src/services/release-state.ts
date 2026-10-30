import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { CURRENT_CONFIGURATION } from "./deployment";

/**
 * The operations agent's releases, in its own state directory:
 * `infra/docker/state/ops-agent/releases`. It holds
 *
 * - `store/`, the release manifests the agent resolved and its pointers to
 *   them (`current.json`, `latest.json`, `transaction.json`,
 *   `selections.json`), with the store lock;
 * - `docker-compose.release.yml`, the overlay pinning the selected release;
 * - `evidence/`, the immutable privacy release-validation files the overlay
 *   mounts.
 *
 * Only the agent's user can reach it, and the host CLI runs as that user. So
 * every directory and file here must be that user's own and unwritable by
 * anyone else; anything else is refused, never repaired.
 */
export const RELEASE_STATE_DIRECTORY = "state/ops-agent/releases";
export const RELEASE_OVERLAY_FILE = "docker-compose.release.yml";

/** The pointer files beside the manifests in the release store. */
export const RELEASE_STORE_POINTER_FILES = [
  "current.json",
  "latest.json",
  "transaction.json",
  "selections.json",
] as const;
export const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** A stored manifest is named after its release: `<releaseId>.json`. */
export const RELEASE_MANIFEST_FILE_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.json$/;
export const RELEASE_STORE_LIMITS = {
  entries: 64,
  manifestBytes: 32 * 1024,
  stateBytes: 4 * 1024,
  transactionBytes: 128 * 1024,
  selectionsBytes: 32 * 1024,
} as const;

export interface ReleaseStatePaths {
  directory: string;
  store: string;
  evidence: string;
  overlay: string;
}

export function releaseStatePaths(infraDir: string): ReleaseStatePaths {
  const directory = join(infraDir, RELEASE_STATE_DIRECTORY);
  return {
    directory,
    store: join(directory, "store"),
    evidence: join(directory, "evidence"),
    overlay: join(directory, RELEASE_OVERLAY_FILE),
  };
}

/** Where releases before this one kept them, in `infra/docker` itself. */
export function legacyReleaseStatePaths(infraDir: string) {
  return {
    store: join(infraDir, ".ops-agent-releases"),
    overlay: join(infraDir, RELEASE_OVERLAY_FILE),
    evidence: join(infraDir, ".release-evidence"),
  };
}

/**
 * The overlay's `file:` reference to an evidence file. Compose resolves an
 * overlay's paths against the project directory, the directory of the first
 * `-f` file: the `current` configuration pointer, taken as named.
 */
export function releaseEvidenceReference(infraDir: string, file: string): string {
  return relative(
    join(infraDir, CURRENT_CONFIGURATION),
    join(releaseStatePaths(infraDir).evidence, file),
  );
}

export interface ReleaseStateOptions {
  /** The uid the release state must belong to: the effective uid unless a test injects one. */
  uid?: number;
}

function stateOwner(options: ReleaseStateOptions): number | undefined {
  return options.uid ?? process.geteuid?.();
}

function mode(stats: { mode: number }): string {
  return `0${(stats.mode & 0o777).toString(8)}`;
}

/**
 * Why `stats` cannot be one of the agent's release-state files, or null: a
 * regular file of this user with one link and no group or other write, of at
 * most `maximum` bytes.
 */
export function releaseStateFileProblem(
  stats: {
    isFile(): boolean;
    isSymbolicLink(): boolean;
    nlink: number;
    uid: number;
    mode: number;
    size: number;
  },
  maximum: number,
  options: ReleaseStateOptions = {},
): string | null {
  const owner = stateOwner(options);
  if (!stats.isFile() || stats.isSymbolicLink()) return "is not a regular file";
  if (stats.nlink !== 1) return "has more than one link";
  if (owner !== undefined && stats.uid !== owner)
    return `is owned by uid ${stats.uid}, not ${owner}`;
  if ((stats.mode & 0o022) !== 0) return `is writable by its group or others (mode ${mode(stats)})`;
  if (stats.size > maximum) return `is larger than ${maximum} bytes`;
  return null;
}

/** A real directory of this user that its group and others cannot reach. */
export function assertReleaseStateDirectory(path: string, options: ReleaseStateOptions = {}): void {
  const stats = lstatSync(path);
  const owner = stateOwner(options);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (owner !== undefined && stats.uid !== owner) ||
    (stats.mode & 0o077) !== 0
  ) {
    throw new Error(
      `Unsafe release state directory: ${path} must be a directory owned by uid ${owner} that its group and others cannot reach`,
    );
  }
}

/** Creates a missing directory owner-only; an existing one is checked, never changed. */
export function ensureReleaseStateDirectory(path: string, options: ReleaseStateOptions = {}): void {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    } catch (created) {
      // Another writer created it first; it is checked like any existing one.
      if ((created as NodeJS.ErrnoException).code !== "EEXIST") throw created;
    }
  }
  assertReleaseStateDirectory(path, options);
}

/** `releases/`, `store/` and `evidence/`, created owner-only when missing. */
export function ensureReleaseStateDirectories(
  infraDir: string,
  options: ReleaseStateOptions = {},
): ReleaseStatePaths {
  const paths = releaseStatePaths(infraDir);
  ensureReleaseStateDirectory(paths.directory, options);
  ensureReleaseStateDirectory(paths.store, options);
  ensureReleaseStateDirectory(paths.evidence, options);
  return paths;
}

/**
 * Reads one of the agent's release-state files. Every check is made on the
 * opened descriptor, so the file cannot be swapped between check and read. A
 * missing file keeps its ENOENT code; a symbolic link fails to open.
 */
export function readReleaseStateFile(
  path: string,
  maximum: number,
  options: ReleaseStateOptions = {},
): string {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new Error(`${path} must be a regular file, not a symbolic link`);
  }
  try {
    const opened = fstatSync(descriptor);
    const problem = releaseStateFileProblem(opened, maximum, options);
    if (problem) throw new Error(`${path} ${problem}`);
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (count === 0) throw new Error(`${path} changed while it was read`);
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      throw new Error(`${path} changed while it was read`);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * The release overlay at `path`, or null when there is none. Its directory and
 * the file itself must be the agent user's own; anything else is refused.
 */
export function readReleaseOverlayFile(
  path: string,
  options: ReleaseStateOptions = {},
): string | null {
  try {
    lstatSync(path);
    assertReleaseStateDirectory(dirname(path), options);
    return readReleaseStateFile(path, RELEASE_STORE_LIMITS.manifestBytes, options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function readReleaseOverlay(
  infraDir: string,
  options: ReleaseStateOptions = {},
): string | null {
  return readReleaseOverlayFile(releaseStatePaths(infraDir).overlay, options);
}

export interface ReleasePointer {
  releaseId: string;
  digest?: string;
  updateJobId?: string;
}

/** `current.json` or `latest.json`; `latest.json` must name its digest. */
export function parseReleasePointer(raw: string, requireDigest: boolean): ReleasePointer {
  const candidate = JSON.parse(raw) as unknown;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("Release authority rejected");
  }
  const value = candidate as Record<string, unknown>;
  if (
    typeof value.releaseId !== "string" ||
    !RELEASE_ID_PATTERN.test(value.releaseId) ||
    (value.digest !== undefined &&
      (typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest))) ||
    (requireDigest && value.digest === undefined) ||
    (value.updateJobId !== undefined &&
      (typeof value.updateJobId !== "string" || !RELEASE_ID_PATTERN.test(value.updateJobId)))
  ) {
    throw new Error("Release authority rejected");
  }
  return {
    releaseId: value.releaseId,
    ...(typeof value.digest === "string" ? { digest: value.digest } : {}),
    ...(typeof value.updateJobId === "string" ? { updateJobId: value.updateJobId } : {}),
  };
}

export type ReleaseSelectionReceipts = Record<
  string,
  { configuration: string; ociDigest: string; digest: string }
>;

/** `selections.json`: which configuration checked each stored release, at which digests. */
export function parseReleaseSelectionReceipts(raw: string): ReleaseSelectionReceipts {
  const value = JSON.parse(raw);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length > RELEASE_STORE_LIMITS.entries
  )
    throw new Error("Invalid release selection receipts");
  for (const [id, receipt] of Object.entries(value) as [string, Record<string, unknown>][])
    if (
      !RELEASE_ID_PATTERN.test(id) ||
      !receipt ||
      Object.keys(receipt).sort().join() !== "configuration,digest,ociDigest" ||
      !/^[a-f0-9]{64}$/.test(String(receipt.configuration)) ||
      !/^[a-f0-9]{64}$/.test(String(receipt.digest)) ||
      !/^sha256:[a-f0-9]{64}$/.test(String(receipt.ociDigest))
    )
      throw new Error("Invalid release selection receipt");
  return value;
}
