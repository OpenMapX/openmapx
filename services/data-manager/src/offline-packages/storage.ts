import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import type { OfflineMapPackageManifest } from "@openmapx/core";
import { validateOfflineMapPackageManifest } from "@openmapx/core";
import type {
  OfflinePackageArchiveHandle,
  OfflinePackageStorageLike,
  OfflinePackageStorageUsage,
  StoredOfflinePackage,
} from "./types.js";

const PACKAGE_ID_PATTERN = /^omp2-[0-9a-f]{64}$/;
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const ARCHIVE_FILENAME = "package.pmtiles";
const MANIFEST_FILENAME = "manifest.json";
const TEMP_DIRECTORY = ".tmp";

export function isContentAddressedPackageId(value: string): boolean {
  return PACKAGE_ID_PATTERN.test(value);
}

function assertPackageId(packageId: string): void {
  if (!isContentAddressedPackageId(packageId)) {
    throw new Error("invalid content-addressed offline package id");
  }
}

function assertJobId(jobId: string): void {
  if (!JOB_ID_PATTERN.test(jobId) || jobId.includes("..")) {
    throw new Error("invalid offline package job id");
  }
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe directory: ${path}`);
}

function assertRegularFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`unsafe package file: ${path}`);
}

function assertDirectChild(root: string, path: string): void {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const relativePath = relative(resolvedRoot, resolvedPath);
  if (!relativePath || relativePath.startsWith("..") || relativePath.includes("/../")) {
    throw new Error("offline package path escapes the package root");
  }
}

function fsyncFile(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } catch {
    // Some filesystems do not allow fsync on directories. The atomic rename
    // remains the visibility boundary; a best-effort directory sync is enough
    // on those filesystems.
  } finally {
    closeSync(fd);
  }
}

async function hashFile(path: string): Promise<string> {
  return await new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk: Buffer | string) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

export function packageDirectory(packageRoot: string, packageId: string): string {
  assertPackageId(packageId);
  const root = resolve(packageRoot);
  const directory = join(root, packageId);
  assertDirectChild(root, directory);
  return directory;
}

export class OfflinePackageStorage implements OfflinePackageStorageLike {
  readonly packageRoot: string;
  private readonly activeStreams = new Map<string, number>();

  constructor(packageRoot: string) {
    this.packageRoot = resolve(packageRoot);
  }

  freeBytes(): number {
    ensureDirectory(this.packageRoot);
    const stats = statfsSync(this.packageRoot);
    return Number(stats.bavail) * Number(stats.bsize);
  }

  packageDirectory(packageId: string): string {
    return packageDirectory(this.packageRoot, packageId);
  }

  temporaryArchivePath(jobId: string): string {
    assertJobId(jobId);
    const tempRoot = join(this.packageRoot, TEMP_DIRECTORY);
    ensureDirectory(tempRoot);
    const path = join(tempRoot, `${jobId}.pmtiles.part`);
    assertDirectChild(tempRoot, path);
    return path;
  }

  private manifestPath(packageId: string): string {
    return join(this.packageDirectory(packageId), MANIFEST_FILENAME);
  }

  private archivePath(packageId: string): string {
    return join(this.packageDirectory(packageId), ARCHIVE_FILENAME);
  }

  async publishPackage(input: {
    archivePath: string;
    manifest: OfflineMapPackageManifest;
  }): Promise<void> {
    const manifest = validateOfflineMapPackageManifest(input.manifest);
    assertPackageId(manifest.packageId);
    const finalDirectory = this.packageDirectory(manifest.packageId);
    const packageRoot = this.packageRoot;
    ensureDirectory(packageRoot);
    assertRegularFile(input.archivePath);
    const archiveStat = statSync(input.archivePath);
    if (archiveStat.size !== manifest.archive.byteLength) {
      throw new Error("offline package archive byte length does not match manifest");
    }
    if ((await hashFile(input.archivePath)) !== manifest.archive.sha256) {
      throw new Error("offline package archive checksum does not match manifest");
    }

    if (existsSync(finalDirectory)) {
      const existing = await this.readPublishedManifest(manifest.packageId);
      if (existing?.archive.sha256 === manifest.archive.sha256) {
        rmSync(input.archivePath, { force: true });
        return;
      }
      if (existing) throw new Error(`offline package already exists: ${manifest.packageId}`);
      if ((this.activeStreams.get(manifest.packageId) ?? 0) > 0) {
        throw new Error(`offline package is currently in use: ${manifest.packageId}`);
      }
      rmSync(finalDirectory, { recursive: true, force: true });
    }

    const tempDirectory = join(
      packageRoot,
      TEMP_DIRECTORY,
      `${manifest.packageId}-${randomUUID()}.package.part`,
    );
    ensureDirectory(join(packageRoot, TEMP_DIRECTORY));
    mkdirSync(tempDirectory, { recursive: true });
    try {
      renameSync(input.archivePath, join(tempDirectory, ARCHIVE_FILENAME));
      writeFileSync(
        join(tempDirectory, MANIFEST_FILENAME),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { flag: "wx" },
      );
      fsyncFile(join(tempDirectory, ARCHIVE_FILENAME));
      fsyncFile(join(tempDirectory, MANIFEST_FILENAME));
      fsyncDirectory(tempDirectory);
      renameSync(tempDirectory, finalDirectory);
      fsyncDirectory(packageRoot);
    } catch (error) {
      rmSync(tempDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  async readPublishedManifest(packageId: string): Promise<OfflineMapPackageManifest | undefined> {
    const directory = this.packageDirectory(packageId);
    if (!existsSync(directory)) return undefined;
    const directoryStat = lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return undefined;
    const manifestPath = this.manifestPath(packageId);
    const archivePath = this.archivePath(packageId);
    if (!existsSync(manifestPath) || !existsSync(archivePath)) return undefined;
    try {
      assertRegularFile(manifestPath);
      assertRegularFile(archivePath);
      const manifest = validateOfflineMapPackageManifest(
        JSON.parse(readFileSync(manifestPath, "utf8")),
      );
      if (manifest.packageId !== packageId) return undefined;
      if (statSync(archivePath).size !== manifest.archive.byteLength) return undefined;
      return manifest;
    } catch {
      return undefined;
    }
  }

  async openPublishedArchive(packageId: string): Promise<OfflinePackageArchiveHandle | undefined> {
    const manifest = await this.readPublishedManifest(packageId);
    if (!manifest) return undefined;
    const path = this.archivePath(packageId);
    const current = this.activeStreams.get(packageId) ?? 0;
    this.activeStreams.set(packageId, current + 1);
    let released = false;
    return {
      path,
      byteLength: manifest.archive.byteLength,
      release: () => {
        if (released) return;
        released = true;
        const count = this.activeStreams.get(packageId) ?? 1;
        if (count <= 1) this.activeStreams.delete(packageId);
        else this.activeStreams.set(packageId, count - 1);
      },
    };
  }

  async listPublishedPackages(): Promise<StoredOfflinePackage[]> {
    if (!existsSync(this.packageRoot)) return [];
    const entries = readdirSync(this.packageRoot, { withFileTypes: true });
    const packages: StoredOfflinePackage[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === TEMP_DIRECTORY) continue;
      if (!isContentAddressedPackageId(entry.name)) continue;
      const manifest = await this.readPublishedManifest(entry.name);
      if (!manifest) continue;
      const archivePath = this.archivePath(entry.name);
      packages.push({
        manifest,
        packageDirectory: this.packageDirectory(entry.name),
        archivePath,
        byteLength: statSync(archivePath).size,
      });
    }
    return packages.sort(
      (a, b) =>
        a.manifest.dataset.generatedAt.localeCompare(b.manifest.dataset.generatedAt) ||
        a.manifest.packageId.localeCompare(b.manifest.packageId),
    );
  }

  async reconcileOfflinePackageStorage(): Promise<{ removed: number }> {
    if (!existsSync(this.packageRoot)) return { removed: 0 };
    const tempRoot = join(this.packageRoot, TEMP_DIRECTORY);
    let removed = 0;
    if (existsSync(tempRoot)) {
      for (const entry of readdirSync(tempRoot, { withFileTypes: true })) {
        const path = join(tempRoot, entry.name);
        rmSync(path, { recursive: true, force: true });
        removed++;
      }
    }
    for (const entry of readdirSync(this.packageRoot, { withFileTypes: true })) {
      if (entry.name === TEMP_DIRECTORY || !entry.isDirectory()) continue;
      if (!isContentAddressedPackageId(entry.name)) continue;
      if (await this.readPublishedManifest(entry.name)) continue;
      if ((this.activeStreams.get(entry.name) ?? 0) > 0) continue;
      rmSync(this.packageDirectory(entry.name), { recursive: true, force: true });
      removed++;
    }
    return { removed };
  }

  async removePackage(packageId: string): Promise<boolean> {
    assertPackageId(packageId);
    if ((this.activeStreams.get(packageId) ?? 0) > 0) return false;
    const directory = this.packageDirectory(packageId);
    if (!existsSync(directory)) return false;
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe package directory");
    rmSync(directory, { recursive: true, force: true });
    fsyncDirectory(this.packageRoot);
    return true;
  }

  async usage(): Promise<OfflinePackageStorageUsage> {
    const packages = await this.listPublishedPackages();
    return {
      packageCount: packages.length,
      byteLength: packages.reduce((total, item) => total + item.byteLength, 0),
    };
  }
}
