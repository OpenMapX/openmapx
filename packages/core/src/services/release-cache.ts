import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fsyncDirectory } from "../release-files";
import {
  canonicalReleaseManifest,
  parseReleaseManifest,
  type ReleaseChannel,
  ReleaseChannelDisabledError,
  type ReleaseManifest,
  releaseManifestDigest,
  releaseServiceImages,
} from "./release-manifest";
import type { ReleaseSelection } from "./release-selection";

/**
 * The operations agent's cache of release manifests it has checked, named by
 * their digest: `infra/docker/state/ops-agent/releases/<digest>.json`. An
 * update names the checked release it applies by that digest; the release a
 * generation runs is kept in the generation itself, not here. The newest file
 * is the release last checked. Only the agent's user may own the directory
 * and its files; anything else is refused, never repaired.
 */
const RELEASE_CACHE_DIRECTORY = "state/ops-agent/releases";
const RELEASE_CACHE_ENTRIES = 64;
const RELEASE_MANIFEST_BYTES = 32 * 1024;
const CACHED_MANIFEST = /^([a-f0-9]{64})\.json$/;
const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ReleaseCacheOptions {
  /** The uid the cache must belong to: the effective uid unless a test injects one. */
  uid?: number;
}

export function releaseCacheDirectory(infraDir: string): string {
  return join(infraDir, RELEASE_CACHE_DIRECTORY);
}

function owner(options: ReleaseCacheOptions): number | undefined {
  return options.uid ?? process.geteuid?.();
}

/** Creates the directory owner-only when missing; an existing one is checked, never changed. */
function cacheDirectory(infraDir: string, options: ReleaseCacheOptions, create: boolean): string {
  const path = releaseCacheDirectory(infraDir);
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stats = lstatSync(path);
  const uid = owner(options);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (uid !== undefined && stats.uid !== uid) ||
    (stats.mode & 0o077) !== 0
  )
    throw new Error(
      `Unsafe release cache: ${path} must be a directory owned by uid ${uid} that its group and others cannot reach`,
    );
  return path;
}

/** One cached file, checked on its opened descriptor so it cannot be swapped meanwhile. */
function readCachedFile(path: string, options: ReleaseCacheOptions): string {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = fstatSync(descriptor);
    const uid = owner(options);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      (uid !== undefined && opened.uid !== uid) ||
      (opened.mode & 0o022) !== 0 ||
      opened.size < 1 ||
      opened.size > RELEASE_MANIFEST_BYTES
    )
      throw new Error(`${path} is not a release manifest of this cache`);
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (count === 0) throw new Error(`${path} changed while it was read`);
      offset += count;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } finally {
    closeSync(descriptor);
  }
}

function cachedEntries(directory: string): { digest: string; mtimeMs: number }[] {
  const entries: { digest: string; mtimeMs: number }[] = [];
  for (const name of readdirSync(directory)) {
    const digest = CACHED_MANIFEST.exec(name)?.[1];
    if (!digest) continue;
    const stats = lstatSync(join(directory, name));
    if (stats.isFile()) entries.push({ digest, mtimeMs: stats.mtimeMs });
  }
  return entries.sort((a, b) => b.mtimeMs - a.mtimeMs || a.digest.localeCompare(b.digest));
}

/**
 * Caches a checked manifest under its digest and marks it the newest. An
 * existing entry must hold the same bytes. The oldest entries beyond the
 * cache's bound are removed.
 */
export function cacheReleaseManifest(
  infraDir: string,
  manifest: ReleaseManifest,
  options: ReleaseCacheOptions = {},
): { releaseId: string; manifestDigest: string } {
  const directory = cacheDirectory(infraDir, options, true);
  const canonical = canonicalReleaseManifest(manifest);
  if (Buffer.byteLength(canonical) > RELEASE_MANIFEST_BYTES)
    throw new Error("Release manifest limit exceeded");
  const manifestDigest = releaseManifestDigest(manifest);
  const path = join(directory, `${manifestDigest}.json`);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, canonical, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    linkSync(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (readCachedFile(path, options) !== canonical)
      throw new Error(`${path} holds another manifest`);
    const now = new Date();
    utimesSync(path, now, now);
  } finally {
    unlinkSync(temporary);
  }
  fsyncDirectory(directory);
  for (const stale of cachedEntries(directory).slice(RELEASE_CACHE_ENTRIES))
    unlinkSync(join(directory, `${stale.digest}.json`));
  return { releaseId: manifest.release, manifestDigest };
}

/** The cached manifest with this digest, checked against the configured image repository. */
export function readCachedReleaseManifest(
  infraDir: string,
  manifestDigest: string,
  imagePrefix: string,
  options: ReleaseCacheOptions = {},
): ReleaseManifest {
  if (!/^[a-f0-9]{64}$/.test(manifestDigest)) throw new Error("Invalid release manifest digest");
  const directory = cacheDirectory(infraDir, options, false);
  const raw = readCachedFile(join(directory, `${manifestDigest}.json`), options);
  const manifest = parseReleaseManifest(raw, imagePrefix);
  if (
    canonicalReleaseManifest(manifest) !== raw ||
    releaseManifestDigest(manifest) !== manifestDigest
  )
    throw new Error("Cached release manifest changed");
  return manifest;
}

/** The cached releases of this image repository, the one checked last first. */
export function cachedReleases(
  infraDir: string,
  imagePrefix: string,
  options: ReleaseCacheOptions = {},
): { manifest: ReleaseManifest; manifestDigest: string }[] {
  let directory: string;
  try {
    directory = cacheDirectory(infraDir, options, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const releases: { manifest: ReleaseManifest; manifestDigest: string }[] = [];
  for (const entry of cachedEntries(directory)) {
    try {
      releases.push({
        manifest: readCachedReleaseManifest(infraDir, entry.digest, imagePrefix, options),
        manifestDigest: entry.digest,
      });
    } catch {
      // A manifest of another configured repository is not this channel's release.
    }
  }
  return releases;
}

function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * A checked release an update names by id and digest. Reading it grants no
 * effect; the effect revalidates the same identity under its own locks.
 */
export function readCheckedConfigurationRelease(
  infraDir: string,
  input: { releaseId: string; manifestDigest: string },
  channel: ReleaseSelection | ReleaseChannel,
  options: ReleaseCacheOptions = {},
) {
  if (channel.kind === "local" || channel.kind === "disabled")
    throw new ReleaseChannelDisabledError();
  if (!RELEASE_ID.test(input.releaseId)) throw new Error("Invalid release id");
  const manifest = readCachedReleaseManifest(
    infraDir,
    input.manifestDigest,
    channel.imagePrefix,
    options,
  );
  if (manifest.release !== input.releaseId)
    throw new Error("Checked configuration release changed");
  return immutable({
    releaseId: input.releaseId,
    manifestDigest: input.manifestDigest,
    manifest,
    serviceImages: { ...releaseServiceImages(manifest) },
  });
}
export type CheckedConfigurationRelease = ReturnType<typeof readCheckedConfigurationRelease>;
