import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open, opendir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateServiceManifest } from "./manifest-schema";
import type { LoadedService, ServiceManifest } from "./types";

export const RELEASE_BUILT_IN_SERVICE_IDS = Object.freeze([
  "app-api",
  "app-web",
  "data-manager",
  "dawarich-app",
  "dawarich-postgis",
  "dawarich-redis",
  "dawarich-sidekiq",
  "elasticsearch",
  "local-ai",
  "martin",
  "motis",
  "motis-feed-proxy",
  "motis-staging",
  "nominatim",
  "ops-agent",
  "osrm",
  "otp",
  "overpass",
  "pelias",
  "pelias-pip",
  "pelias-placeholder",
  "photon",
  "postgis",
  "redis",
  "tileserver",
  "traefik",
  "transitous-runner",
  "valhalla",
  "well-known",
] as const);

export const RELEASE_NEVER_MANAGE_SERVICE_IDS = Object.freeze([
  "app-api",
  "ops-agent",
  "traefik",
] as const);

const SERVICE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;

interface CapturedDirectory {
  path: string;
  handle: FileHandle;
  dev: number;
  ino: number;
}

export interface ReleaseServiceAuthorityCapture {
  readonly serviceIds: readonly string[];
  readonly services: readonly LoadedService[];
  readonly digest: string;
}

export interface ReleaseServiceAuthorityCaptureHooks {
  beforeManifestOpen?(id: string, path: string): void;
  afterFirstManifestRead?(id: string, path: string): void;
}

function deepFreeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) deepFreeze(child);
  Object.freeze(value);
}

async function openCapturedDirectory(path: string): Promise<CapturedDirectory> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isDirectory() || (metadata.mode & 0o022) !== 0) throw new Error("invalid");
    return { path, handle, dev: metadata.dev, ino: metadata.ino };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function recheckDirectory(directory: CapturedDirectory): Promise<void> {
  const opened = await directory.handle.stat();
  const currentHandle = await open(
    directory.path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const current = await currentHandle.stat();
    if (
      !opened.isDirectory() ||
      !current.isDirectory() ||
      (opened.mode & 0o022) !== 0 ||
      (current.mode & 0o022) !== 0 ||
      opened.dev !== directory.dev ||
      opened.ino !== directory.ino ||
      current.dev !== directory.dev ||
      current.ino !== directory.ino
    ) {
      throw new Error("invalid");
    }
  } finally {
    await currentHandle.close();
  }
}

async function recheckDirectories(directories: readonly CapturedDirectory[]): Promise<void> {
  for (const directory of directories) await recheckDirectory(directory);
}

async function readCapturedManifest(
  path: string,
  directories: readonly CapturedDirectory[],
  beforeOpen: () => void,
  afterFirstRead: () => void,
): Promise<{ bytes: Buffer; raw: unknown }> {
  await recheckDirectories(directories);
  beforeOpen();
  await recheckDirectories(directories);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    const pathnameMetadata = await lstat(path);
    if (
      !metadata.isFile() ||
      !pathnameMetadata.isFile() ||
      pathnameMetadata.isSymbolicLink() ||
      metadata.nlink !== 1 ||
      metadata.size < 2 ||
      metadata.size > MAX_MANIFEST_BYTES ||
      (metadata.mode & 0o022) !== 0 ||
      !sameManifestMetadata(metadata, pathnameMetadata)
    )
      throw new Error("invalid");
    const bytes = await readExactManifest(handle, metadata.size);
    afterFirstRead();
    const afterFirst = await handle.stat();
    const pathnameAfterFirst = await lstat(path);
    await recheckDirectories(directories);
    const second = await readExactManifest(handle, metadata.size);
    const afterSecond = await handle.stat();
    const pathnameAfterSecond = await lstat(path);
    await recheckDirectories(directories);
    if (
      !sameManifestMetadata(metadata, afterFirst) ||
      !sameManifestMetadata(metadata, pathnameAfterFirst) ||
      !sameManifestMetadata(metadata, afterSecond) ||
      !sameManifestMetadata(metadata, pathnameAfterSecond) ||
      !bytes.equals(second)
    ) {
      throw new Error("invalid");
    }
    return {
      bytes,
      raw: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
    };
  } finally {
    await handle.close();
  }
}

function sameManifestMetadata(left: Stats, right: Stats): boolean {
  return (
    left.isFile() === right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function readExactManifest(handle: FileHandle, size: number): Promise<Buffer> {
  const bytes = Buffer.alloc(size);
  const result = await handle.read(bytes, 0, bytes.length, 0);
  if (result.bytesRead !== bytes.length) throw new Error("invalid");
  const trailing = Buffer.alloc(1);
  if ((await handle.read(trailing, 0, 1, size)).bytesRead !== 0) throw new Error("invalid");
  return bytes;
}

export async function captureReleaseServiceAuthority(
  rootDir: string,
  hooks: ReleaseServiceAuthorityCaptureHooks = {},
): Promise<ReleaseServiceAuthorityCapture> {
  const directories: CapturedDirectory[] = [];
  try {
    const fixedRoot = resolve(rootDir);
    const servicesDir = join(fixedRoot, "services");
    directories.push(await openCapturedDirectory(fixedRoot));
    directories.push(await openCapturedDirectory(servicesDir));
    await recheckDirectories(directories);
    const expected = new Set<string>([
      ...RELEASE_BUILT_IN_SERVICE_IDS,
      ...RELEASE_NEVER_MANAGE_SERVICE_IDS,
    ]);
    const found = new Set<string>();
    const directory = await opendir(servicesDir);
    try {
      for await (const entry of directory) {
        if (entry.name === ".community" || entry.name.startsWith(".")) continue;
        if (!SERVICE_ID.test(entry.name) || !entry.isDirectory() || !expected.has(entry.name)) {
          throw new Error("invalid");
        }
        if (found.has(entry.name)) throw new Error("invalid");
        found.add(entry.name);
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    await recheckDirectories(directories);
    if (found.size !== expected.size || [...expected].some((id) => !found.has(id))) {
      throw new Error("invalid");
    }
    const services: LoadedService[] = [];
    const digest = createHash("sha256").update("openmapx-release-service-authority-v1\0");
    for (const id of [...expected].sort()) {
      const serviceDir = join(servicesDir, id);
      const capturedDirectory = await openCapturedDirectory(serviceDir);
      directories.push(capturedDirectory);
      const manifestPath = join(serviceDir, "service.json");
      const { bytes, raw } = await readCapturedManifest(
        manifestPath,
        directories,
        () => hooks.beforeManifestOpen?.(id, manifestPath),
        () => hooks.afterFirstManifestRead?.(id, manifestPath),
      );
      const validation = validateServiceManifest(raw, { firstParty: true });
      if (!validation.valid || !raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("invalid");
      }
      if ((raw as Record<string, unknown>).id !== id) throw new Error("invalid");
      digest.update(id).update("\0").update(bytes).update("\0");
      services.push({
        manifest: raw as ServiceManifest,
        directory: serviceDir,
        isBuiltIn: true,
        enabled: true,
      });
    }
    await recheckDirectories(directories);
    const snapshot: ReleaseServiceAuthorityCapture = {
      serviceIds: [...expected].sort(),
      services,
      digest: `release1_${digest.digest("base64url")}`,
    };
    deepFreeze(snapshot);
    return snapshot;
  } catch {
    throw new Error("Release service authority is unavailable");
  } finally {
    await Promise.all(
      directories.map((directory) => directory.handle.close().catch(() => undefined)),
    );
  }
}

export async function validateReleaseServiceAuthority(rootDir: string): Promise<Set<string>> {
  const snapshot = await captureReleaseServiceAuthority(rootDir);
  return new Set(snapshot.serviceIds);
}
