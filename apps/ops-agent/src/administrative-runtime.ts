import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  OPS_MAX_BACKUP_ID_LENGTH,
  OPS_MAX_BACKUP_INVENTORY_ENTRIES,
  type OpsResultFor,
} from "@openmapx/core/ops";
import { services as coreServices } from "@openmapx/core/server";
import { inspectDataInventory } from "./data-inventory";
import { listDescriptorAnchoredDirectory, readDescriptorAnchoredUtf8 } from "./descriptor-file";
import { runContainedProcess } from "./docker-runtime";
import type { OpsExecutionContext, OpsRuntime } from "./runtime";

const MAX_BACKUP_MANIFEST_BYTES = 1024 * 1024;
const MAX_BACKUP_SERVICES = 256;
const MAX_BACKUP_VOLUMES = 4_096;
const MAX_CLI_OUTPUT_BYTES = 1024 * 1024;
const MAX_CLI_DURATION_MS = 30 * 60_000;
const MAX_RELEASE_MANIFEST_BYTES = 32 * 1024;
const MAX_RELEASE_STATE_BYTES = 4 * 1024;
const MAX_RELEASE_TRANSACTION_BYTES = 128 * 1024;
const MAX_RELEASE_STORE_ENTRIES = 64;
const RELEASE_STORE_LOCK_NAME = ".release-store.lock";
const BACKUP_STORE_LOCK_NAME = ".backup-store.lock";
const RELEASE_STORE_LOCK_TTL_MS = 15 * 60_000;
const RELEASE_STORE_LOCK_ACQUIRE_TIMEOUT_MS = 60_000;
const RELEASE_STORE_LOCK_RETRY_MS = 50;
const MAX_RELEASE_STORE_BYTES = MAX_RELEASE_STORE_ENTRIES * MAX_RELEASE_MANIFEST_BYTES;
const BACKUP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SERVICE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REGION_ID = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/;
const DATA_TYPE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DATA_TYPE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  osm: ["osm-pbf"],
  "osm-bz2": ["osm-pbf-bz2"],
  overpass: ["osm-pbf-bz2"],
  fonts: ["tile-fonts"],
  mbtiles: ["tile-mbtiles"],
  tiles: ["tile-mbtiles", "tile-fonts"],
};

type BackupKind = "backup.create" | "backup.restore" | "backup.delete";
type BackupInventoryEntry = OpsResultFor<"backup.list">["backups"][number];

export interface FixedCliOptions {
  signal: AbortSignal;
  emitLog(stream: "stdout" | "stderr", message: string): void;
}

export type FixedCliRunner = (args: readonly string[], options: FixedCliOptions) => Promise<void>;

export interface AdministrativeRuntimeOptions {
  rootDir: string;
  runFixedCli?: FixedCliRunner;
  releaseEffects?: AdministrativeReleaseEffects;
  loadBuildAuthority?: () => Promise<readonly BuildAuthorityService[]>;
}

export interface BuildAuthorityService {
  serviceId: string;
  enabled: boolean;
  isBuiltIn: boolean;
  buildCommand?: string;
}

export interface AdministrativeReleaseEffects {
  initialize?(): Promise<void>;
  resolve(context: FixedCliOptions): Promise<string>;
  pull(releaseId: string, context: FixedCliOptions): Promise<void>;
  inspect(): Promise<{ currentReleaseId?: string; availableReleaseId?: string }>;
  inspectSystem(context: FixedCliOptions): Promise<OpsResultFor<"system.inspect">>;
  apply(
    releaseId: string,
    serviceIds: readonly [string, ...string[]],
    context: FixedCliOptions,
    updateJobId?: string,
  ): Promise<void>;
  runtimeInspect?(): Promise<{ releaseId?: string; updateJobId?: string }>;
}

export interface AdministrativeReleaseRuntimeOptions {
  runDocker?: (args: readonly string[], context: FixedCliOptions) => Promise<string>;
  afterReleasePhase?: (phase: ReleaseTransactionPhase) => void | Promise<void>;
  verifyAppliedRelease?: (
    manifest: ReturnType<typeof coreServices.parseReleaseManifest>,
    serviceIds: readonly string[],
    context: FixedCliOptions,
  ) => Promise<boolean>;
  /** Crash points inside release-store lock acquisition, for recovery tests. */
  releaseStoreLockHooks?: ReleaseStoreLockHooks;
}

export type ReleaseTransactionPhase =
  | "prepared"
  | "overlay_written"
  | "services_applied"
  | "state_published"
  | "rollback_overlay"
  | "rollback_services";

interface ParsedBackupManifest {
  name: string;
  createdAt: string;
  openmapxVersion: string;
  services: Array<{ id: string; version: string; volumes: Array<{ sizeBytes: number }> }>;
}

interface DataAuthorityService {
  manifest: {
    produces?: ReadonlyArray<{ type: string }>;
    consumes?: ReadonlyArray<{ type: string }>;
  };
}

export function inspectRegionAuthority(regionId: string): boolean {
  return loadConfiguredResourceAuthority().regions.has(regionId);
}

const COUNTRY_ID = /^[A-Z]{2,3}$/;

export interface ConfiguredResourceAuthority {
  revisionId: string;
  regions: ReadonlySet<string>;
  countries: ReadonlySet<string>;
}

function exactConfiguredIds(
  raw: string | undefined,
  pattern: RegExp,
  maximumLength: number,
): string[] {
  const values = (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    values.length > 64 ||
    values.some((value) => value.length > maximumLength || !pattern.test(value)) ||
    new Set(values).size !== values.length
  ) {
    throw new Error("Resource authority configuration rejected");
  }
  return values.sort();
}

export function loadConfiguredResourceAuthority(
  env: NodeJS.ProcessEnv = process.env,
): ConfiguredResourceAuthority {
  const regions = exactConfiguredIds(
    env.OPENMAPX_ALLOWED_REGIONS ?? "europe/germany",
    REGION_ID,
    128,
  );
  const countries = exactConfiguredIds(env.OPENMAPX_ALLOWED_COUNTRIES ?? "DE", COUNTRY_ID, 3);
  const digest = createHash("sha256")
    .update("openmapx-resource-authority-v1\0")
    .update(JSON.stringify({ regions, countries }))
    .digest("hex");
  return {
    revisionId: `resources-${digest}`,
    regions: new Set(regions),
    countries: new Set(countries),
  };
}

export function inspectDataTypeAuthority(
  services: readonly DataAuthorityService[],
  dataTypeId: string,
): boolean {
  if (dataTypeId === "all") return true;
  if (!DATA_TYPE_ID.test(dataTypeId)) return false;
  const types = new Set<string>();
  for (const service of services.slice(0, 256)) {
    for (const resource of [
      ...(service.manifest.produces ?? []),
      ...(service.manifest.consumes ?? []),
    ]) {
      if (DATA_TYPE_ID.test(resource.type)) types.add(resource.type);
    }
  }
  if (types.has(dataTypeId)) return true;
  const targets = DATA_TYPE_ALIASES[dataTypeId];
  return targets?.some((target) => types.has(target)) ?? false;
}

function backupRoot(rootDir: string): string {
  return join(rootDir, "infra", "docker", "backups");
}

function assertBackupId(backupId: string): void {
  if (
    backupId.length < 1 ||
    backupId.length > OPS_MAX_BACKUP_ID_LENGTH ||
    !BACKUP_ID.test(backupId)
  ) {
    throw new Error("Backup authority rejected");
  }
}

function strictDirectory(path: string): ReturnType<typeof lstatSync> | null {
  try {
    const stats = lstatSync(path);
    if (!stats.isDirectory() || stats.isSymbolicLink())
      throw new Error("Backup authority rejected");
    return stats;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Backup authority rejected");
  }
}

/**
 * A Compose file must be a real, readable, non-symlinked regular file before it
 * can be treated as an input. Directories, dangling symlinks, and unreadable
 * entries are reported as absent rather than ready.
 */
function isRegularComposeFile(path: string): boolean {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) return false;
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function parseManifest(rootDir: string, backupId: string): ParsedBackupManifest {
  let candidate: unknown;
  try {
    candidate = JSON.parse(
      readDescriptorAnchoredUtf8(
        rootDir,
        ["infra", "docker", "backups", backupId, "manifest.json"],
        { minimumBytes: 1, maximumBytes: MAX_BACKUP_MANIFEST_BYTES },
      ),
    );
  } catch {
    throw new Error("Backup authority rejected");
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("Backup authority rejected");
  }
  const raw = candidate as Record<string, unknown>;
  if (
    raw.name !== backupId ||
    typeof raw.createdAt !== "string" ||
    !Number.isFinite(Date.parse(raw.createdAt)) ||
    typeof raw.openmapxVersion !== "string" ||
    raw.openmapxVersion.length < 1 ||
    raw.openmapxVersion.length > 64 ||
    !Array.isArray(raw.services) ||
    raw.services.length > MAX_BACKUP_SERVICES
  ) {
    throw new Error("Backup authority rejected");
  }
  const seenServices = new Set<string>();
  let volumeCount = 0;
  const services = raw.services.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Backup authority rejected");
    }
    const service = value as Record<string, unknown>;
    if (
      typeof service.id !== "string" ||
      !SERVICE_ID.test(service.id) ||
      seenServices.has(service.id) ||
      typeof service.version !== "string" ||
      service.version.length < 1 ||
      service.version.length > 64 ||
      !Array.isArray(service.volumes)
    ) {
      throw new Error("Backup authority rejected");
    }
    seenServices.add(service.id);
    volumeCount += service.volumes.length;
    if (volumeCount > MAX_BACKUP_VOLUMES) throw new Error("Backup authority rejected");
    const volumes = service.volumes.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("Backup authority rejected");
      }
      const sizeBytes = (entry as Record<string, unknown>).sizeBytes;
      if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
        throw new Error("Backup authority rejected");
      }
      return { sizeBytes };
    });
    return { id: service.id, version: service.version, volumes };
  });
  return {
    name: backupId,
    createdAt: new Date(raw.createdAt).toISOString(),
    openmapxVersion: raw.openmapxVersion,
    services,
  };
}

function corruptEntry(
  backupId: string,
  reason: "missing_manifest" | "invalid_manifest" | "unsafe_entry",
): BackupInventoryEntry {
  return {
    backupId,
    createdAt: new Date(0).toISOString(),
    serviceCount: 0,
    volumeCount: 0,
    totalBytes: 0,
    corrupt: true,
    corruptReason: reason,
  };
}

export function inspectBackupInventory(rootDir: string): OpsResultFor<"backup.list"> {
  const root = backupRoot(rootDir);
  if (!strictDirectory(root)) return { backups: [], warningCount: 0 };
  const entries = listDescriptorAnchoredDirectory(rootDir, ["infra", "docker", "backups"], {
    maximumEntries: OPS_MAX_BACKUP_INVENTORY_ENTRIES,
  });
  const backups: BackupInventoryEntry[] = [];
  let warningCount = 0;
  for (const entry of entries) {
    if (!BACKUP_ID.test(entry.name) || entry.name.length > OPS_MAX_BACKUP_ID_LENGTH) {
      throw new Error("Backup authority rejected");
    }
    if (entry.type !== "directory") {
      backups.push(corruptEntry(entry.name, "unsafe_entry"));
      warningCount += 1;
      continue;
    }
    let manifest: ParsedBackupManifest;
    try {
      const children = listDescriptorAnchoredDirectory(
        rootDir,
        ["infra", "docker", "backups", entry.name],
        { maximumEntries: MAX_BACKUP_VOLUMES + 1 },
      );
      if (!children.some((child) => child.name === "manifest.json" && child.type === "file")) {
        backups.push(corruptEntry(entry.name, "missing_manifest"));
        warningCount += 1;
        continue;
      }
      manifest = parseManifest(rootDir, entry.name);
    } catch {
      backups.push(corruptEntry(entry.name, "invalid_manifest"));
      warningCount += 1;
      continue;
    }
    const volumes = manifest.services.flatMap((service) => service.volumes);
    backups.push({
      backupId: entry.name,
      createdAt: manifest.createdAt,
      platformVersion: manifest.openmapxVersion,
      serviceCount: manifest.services.length,
      volumeCount: volumes.length,
      totalBytes: volumes.reduce((total, volume) => total + volume.sizeBytes, 0),
    });
  }
  backups.sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) || left.backupId.localeCompare(right.backupId),
  );
  return { backups, warningCount };
}

export async function inspectBackupAuthority(
  rootDir: string,
  kind: BackupKind,
  backupId: string,
  serviceIds: readonly string[] = [],
): Promise<boolean> {
  try {
    assertBackupId(backupId);
    const root = backupRoot(rootDir);
    const rootStats = strictDirectory(root);
    if (!rootStats) return kind === "backup.create";
    const entries = listDescriptorAnchoredDirectory(rootDir, ["infra", "docker", "backups"], {
      maximumEntries: OPS_MAX_BACKUP_INVENTORY_ENTRIES,
    });
    const entry = entries.find((candidate) => candidate.name === backupId);
    if (kind === "backup.create") return entry === undefined;
    if (entry?.type !== "directory") return false;
    if (kind === "backup.delete") return true;
    const manifest = parseManifest(rootDir, backupId);
    const available = new Set(manifest.services.map((service) => service.id));
    return serviceIds.every((serviceId) => available.has(serviceId));
  } catch {
    return false;
  }
}

function emitLines(
  emitLog: OpsExecutionContext["emitLog"],
  stream: "stdout" | "stderr",
  contents: string,
): void {
  for (const line of contents.split(/\r?\n/).filter(Boolean)) {
    emitLog(stream, line);
  }
}

function releaseDirectory(rootDir: string): string {
  return join(rootDir, "infra", "docker", ".ops-agent-releases");
}

function releaseManifestPath(rootDir: string, releaseId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(releaseId)) {
    throw new Error("Release authority rejected");
  }
  return join(releaseDirectory(rootDir), `${releaseId}.json`);
}

export function inspectReleaseAuthority(rootDir: string, releaseId: string): boolean {
  try {
    const manifest = coreServices.parseReleaseManifest(
      strictReadFile(releaseManifestPath(rootDir, releaseId), MAX_RELEASE_MANIFEST_BYTES),
    );
    return manifest.release === releaseId;
  } catch {
    return false;
  }
}

function strictReadFile(path: string, maximum: number): string {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) {
    throw new Error("Release authority rejected");
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error("Release authority rejected");
    }
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (count === 0) throw new Error("Release authority rejected");
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      throw new Error("Release authority rejected");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } finally {
    closeSync(descriptor);
  }
}

function canonicalReleaseManifest(
  manifest: ReturnType<typeof coreServices.parseReleaseManifest>,
): string {
  return JSON.stringify({
    schemaVersion: 1,
    release: manifest.release,
    images: {
      api: manifest.images.api,
      web: manifest.images.web,
      "data-manager": manifest.images["data-manager"],
      "ops-agent": manifest.images["ops-agent"],
      "transitous-runner": manifest.images["transitous-runner"],
      "transitous-tools": manifest.images["transitous-tools"],
      docs: manifest.images.docs,
    },
  });
}

function releaseDigest(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function atomicWrite(path: string, contents: string): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  let writeError: unknown;
  try {
    renameSync(temporary, path);
    fsyncDirectory(dirname(path));
  } catch (error) {
    writeError = error;
  }
  try {
    unlinkSync(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && writeError === undefined) {
      writeError = error;
    }
  }
  if (writeError !== undefined) throw writeError;
}

function immutableWrite(path: string, contents: string): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  let writeError: unknown;
  try {
    linkSync(temporary, path);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      writeError = error;
    } else {
      try {
        if (strictReadFile(path, MAX_RELEASE_MANIFEST_BYTES) !== contents) {
          writeError = new Error("Release authority rejected");
        }
      } catch (readError) {
        writeError = readError;
      }
    }
  }
  try {
    unlinkSync(temporary);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && writeError === undefined) {
      writeError = error;
    }
  }
  if (writeError !== undefined) throw writeError;
}

/**
 * A no-replace, cross-process lock over the release store.
 *
 * `mkdir` is atomic and fails with `EEXIST` when the directory already exists,
 * so it serializes ops-agent processes without a shared runtime. The owner
 * record inside it carries a lease: a holder that died without releasing is
 * reclaimed only after the lease expires, and reclamation itself races through
 * the same `mkdir`, so two reclaimers cannot both win.
 */
interface ReleaseStoreLock {
  release(): void;
}

interface ReleaseStoreLockHooks {
  afterLockDirectoryCreate?: () => void;
  beforeOwnerRecordWrite?: () => void;
}

async function acquireStoreLock(
  directory: string,
  lockName: string,
  hooks: ReleaseStoreLockHooks = {},
  nowMs: () => number = Date.now,
): Promise<ReleaseStoreLock> {
  const lockPath = join(directory, lockName);
  const ownerPath = join(lockPath, "owner.json");
  const deadline = nowMs() + RELEASE_STORE_LOCK_ACQUIRE_TIMEOUT_MS;
  const owner = { pid: process.pid, nonce: randomUUID() };
  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      hooks.afterLockDirectoryCreate?.();
      hooks.beforeOwnerRecordWrite?.();
      atomicWrite(ownerPath, JSON.stringify({ ...owner, acquiredAtMs: nowMs() }));
      fsyncDirectory(lockPath);
      return {
        release() {
          durableUnlink(ownerPath);
          try {
            rmSync(lockPath, { recursive: true, force: true });
            fsyncDirectory(directory);
          } catch {
            // A already-removed lock directory is not an error: the caller's
            // critical section is over either way.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Held by someone else. Reclaim only an expired lease, and only by
    // removing the exact directory we observed as expired.
    let expired = false;
    try {
      const raw = strictReadFile(ownerPath, MAX_RELEASE_STATE_BYTES);
      const record = JSON.parse(raw) as { acquiredAtMs?: unknown };
      expired =
        typeof record.acquiredAtMs !== "number" ||
        !Number.isFinite(record.acquiredAtMs) ||
        nowMs() - record.acquiredAtMs > RELEASE_STORE_LOCK_TTL_MS;
    } catch (error) {
      // A lock directory without a readable owner record is either mid-
      // acquisition or abandoned before its record landed. Treat it as
      // expired only once it is older than the lease.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        let createdAtMs = Number.POSITIVE_INFINITY;
        try {
          createdAtMs = lstatSync(lockPath).mtimeMs;
        } catch {
          continue;
        }
        expired = nowMs() - createdAtMs > RELEASE_STORE_LOCK_TTL_MS;
      } else {
        throw new Error("Release store lock is unreadable");
      }
    }
    if (expired) {
      try {
        rmSync(lockPath, { recursive: true, force: true });
        fsyncDirectory(directory);
      } catch {
        // Another process reclaimed it first; retry through mkdir.
      }
      continue;
    }
    if (nowMs() >= deadline) throw new Error("Release store is busy");
    await new Promise((resolve) => setTimeout(resolve, RELEASE_STORE_LOCK_RETRY_MS));
  }
}

function acquireReleaseStoreLock(
  directory: string,
  hooks: ReleaseStoreLockHooks = {},
): Promise<ReleaseStoreLock> {
  return acquireStoreLock(directory, RELEASE_STORE_LOCK_NAME, hooks);
}

function acquireBackupStoreLock(rootDir: string): Promise<ReleaseStoreLock> {
  const root = backupRoot(rootDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return acquireStoreLock(root, BACKUP_STORE_LOCK_NAME);
}

/**
 * Digest of the exact canonical backup-manifest bytes, or null when the backup
 * is absent or unreadable. Used to prove that the bytes an effect acts on are
 * the bytes that were authorized.
 */
export function inspectBackupManifestDigest(rootDir: string, backupId: string): string | null {
  try {
    assertBackupId(backupId);
    const raw = readDescriptorAnchoredUtf8(
      rootDir,
      ["infra", "docker", "backups", backupId, "manifest.json"],
      { minimumBytes: 1, maximumBytes: MAX_BACKUP_MANIFEST_BYTES },
    );
    return createHash("sha256").update(raw).digest("hex");
  } catch {
    return null;
  }
}

function durableUnlink(path: string): void {
  try {
    unlinkSync(path);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function createDefaultReleaseEffects(
  rootDir: string,
  runFixedCli: FixedCliRunner,
  runtimeOptions: AdministrativeReleaseRuntimeOptions = {},
): AdministrativeReleaseEffects {
  const directory = releaseDirectory(rootDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const releaseStoreLockHooks = runtimeOptions.releaseStoreLockHooks ?? {};
  const paths = {
    overlay: join(rootDir, "infra", "docker", "docker-compose.release.yml"),
    state: join(directory, "current.json"),
    latest: join(directory, "latest.json"),
    transaction: join(directory, "transaction.json"),
  };
  const repositoryPaths = {
    composeOutPath: join(rootDir, "infra", "docker", "docker-compose.generated.yml"),
    composeReleasePath: join(rootDir, "infra", "docker", "docker-compose.release.yml"),
  };
  const manifestNames = () => {
    const entries = readdirSync(directory);
    if (entries.length > MAX_RELEASE_STORE_ENTRIES + 4)
      throw new Error("Release store limit exceeded");
    let bytes = 0;
    const names: string[] = [];
    for (const name of entries) {
      // The lock is agent-owned coordination state, not a stored release.
      if (name === RELEASE_STORE_LOCK_NAME) {
        const stat = lstatSync(join(directory, name));
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error("Release store contains an unsafe entry");
        }
        continue;
      }
      if (["current.json", "latest.json", "transaction.json"].includes(name)) {
        const stat = lstatSync(join(directory, name));
        const maximum =
          name === "transaction.json" ? MAX_RELEASE_TRANSACTION_BYTES : MAX_RELEASE_STATE_BYTES;
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1 ||
          stat.size < 1 ||
          stat.size > maximum
        ) {
          throw new Error("Release store contains an unsafe entry");
        }
        continue;
      }
      const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.json$/.exec(name);
      if (!match) throw new Error("Release store contains an unsafe entry");
      const stat = lstatSync(join(directory, name));
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.size < 1 ||
        stat.size > MAX_RELEASE_MANIFEST_BYTES
      ) {
        throw new Error("Release store contains an unsafe entry");
      }
      bytes += stat.size;
      if (bytes > MAX_RELEASE_STORE_BYTES || names.length >= MAX_RELEASE_STORE_ENTRIES) {
        throw new Error("Release store limit exceeded");
      }
      names.push(match[1] as string);
    }
    return names;
  };
  const loadManifest = (releaseId: string) => {
    manifestNames();
    const raw = strictReadFile(releaseManifestPath(rootDir, releaseId), MAX_RELEASE_MANIFEST_BYTES);
    const manifest = coreServices.parseReleaseManifest(raw);
    if (manifest.release !== releaseId || raw !== canonicalReleaseManifest(manifest)) {
      throw new Error("Release authority rejected");
    }
    return manifest;
  };
  const runDocker =
    runtimeOptions.runDocker ??
    (async (args: readonly string[], context: FixedCliOptions) => {
      const result = await runContainedProcess("docker", args, {
        signal: context.signal,
        timeout: MAX_CLI_DURATION_MS,
        maxBuffer: MAX_CLI_OUTPUT_BYTES,
      });
      emitLines(context.emitLog, "stdout", result.stdout);
      emitLines(context.emitLog, "stderr", result.stderr);
      return result.stdout;
    });
  const readReleasePointer = (
    path: string,
    optional: boolean,
  ): { releaseId?: string; updateJobId?: string; digest?: string } => {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new Error("Release authority rejected");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && optional) return {};
      throw new Error("Release authority rejected");
    }
    const candidate = JSON.parse(strictReadFile(path, MAX_RELEASE_STATE_BYTES)) as unknown;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("Release authority rejected");
    }
    const value = candidate as Record<string, unknown>;
    if (
      typeof value.releaseId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.releaseId) ||
      (value.digest !== undefined &&
        (typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest))) ||
      (path === paths.latest && value.digest === undefined) ||
      (value.updateJobId !== undefined &&
        (typeof value.updateJobId !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.updateJobId)))
    ) {
      throw new Error("Release authority rejected");
    }
    const manifest = loadManifest(value.releaseId);
    const digest = releaseDigest(canonicalReleaseManifest(manifest));
    if (value.digest !== undefined && digest !== value.digest) {
      throw new Error("Release authority rejected");
    }
    return {
      releaseId: value.releaseId,
      digest,
      ...(typeof value.updateJobId === "string" ? { updateJobId: value.updateJobId } : {}),
    };
  };
  const readState = () => readReleasePointer(paths.state, true);
  const inspectRelease = async () => {
    const state = readState();
    const candidates = manifestNames();
    const latest = readReleasePointer(paths.latest, true);
    const availableReleaseId =
      latest.releaseId ?? (candidates.length === 1 ? candidates[0] : undefined);
    return {
      ...(state.releaseId ? { currentReleaseId: state.releaseId } : {}),
      ...(availableReleaseId ? { availableReleaseId } : {}),
    };
  };
  const inspectImageId = async (
    args: readonly string[],
    context: FixedCliOptions,
  ): Promise<string | undefined> => {
    try {
      const value = (await runDocker(args, context)).trim();
      return /^sha256:[a-f0-9]{64}$/.test(value) ? value : undefined;
    } catch {
      return undefined;
    }
  };
  interface ReleaseTransaction {
    version: 1;
    phase: ReleaseTransactionPhase;
    releaseId: string;
    digest: string;
    serviceIds: string[];
    updateJobId?: string;
    previousOverlay: string | null;
    previousState: string | null;
  }
  const readTransaction = (): ReleaseTransaction | null => {
    try {
      const stat = lstatSync(paths.transaction);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new Error("Release transaction rejected");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("Release transaction rejected");
    }
    const raw = strictReadFile(paths.transaction, MAX_RELEASE_TRANSACTION_BYTES);
    const candidate = JSON.parse(raw) as unknown;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("Release transaction rejected");
    }
    const value = candidate as Record<string, unknown>;
    const phases = new Set<ReleaseTransactionPhase>([
      "prepared",
      "overlay_written",
      "services_applied",
      "state_published",
      "rollback_overlay",
      "rollback_services",
    ]);
    if (
      value.version !== 1 ||
      typeof value.phase !== "string" ||
      !phases.has(value.phase as ReleaseTransactionPhase) ||
      typeof value.releaseId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.releaseId) ||
      typeof value.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.digest) ||
      !Array.isArray(value.serviceIds) ||
      value.serviceIds.length < 1 ||
      value.serviceIds.length > 3 ||
      value.serviceIds.some(
        (serviceId) =>
          typeof serviceId !== "string" ||
          !["app-api", "app-web", "data-manager"].includes(serviceId),
      ) ||
      new Set(value.serviceIds).size !== value.serviceIds.length ||
      (value.updateJobId !== undefined &&
        (typeof value.updateJobId !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.updateJobId))) ||
      (value.previousOverlay !== null &&
        (typeof value.previousOverlay !== "string" ||
          Buffer.byteLength(value.previousOverlay, "utf8") > MAX_RELEASE_MANIFEST_BYTES)) ||
      (value.previousState !== null &&
        (typeof value.previousState !== "string" ||
          Buffer.byteLength(value.previousState, "utf8") > MAX_RELEASE_STATE_BYTES))
    ) {
      throw new Error("Release transaction rejected");
    }
    const transaction = value as unknown as ReleaseTransaction;
    const manifest = loadManifest(transaction.releaseId);
    if (releaseDigest(canonicalReleaseManifest(manifest)) !== transaction.digest) {
      throw new Error("Release transaction rejected");
    }
    return transaction;
  };
  const writeTransaction = async (transaction: ReleaseTransaction): Promise<void> => {
    atomicWrite(paths.transaction, JSON.stringify(transaction));
    await runtimeOptions.afterReleasePhase?.(transaction.phase);
  };
  const publishState = (transaction: ReleaseTransaction): void => {
    atomicWrite(
      paths.state,
      JSON.stringify({
        releaseId: transaction.releaseId,
        digest: transaction.digest,
        ...(transaction.updateJobId ? { updateJobId: transaction.updateJobId } : {}),
      }),
    );
  };
  const verifyApplied =
    runtimeOptions.verifyAppliedRelease ??
    (async (
      manifest: ReturnType<typeof coreServices.parseReleaseManifest>,
      serviceIds: readonly string[],
      context: FixedCliOptions,
    ) => {
      if (!existsSync(repositoryPaths.composeOutPath)) return false;
      const composeArgs = [
        "compose",
        "-f",
        repositoryPaths.composeOutPath,
        "-f",
        repositoryPaths.composeReleasePath,
      ];
      const images: Record<string, string> = {
        "app-api": manifest.images.api,
        "app-web": manifest.images.web,
        "data-manager": manifest.images["data-manager"],
      };
      for (const serviceId of serviceIds) {
        const expected = await inspectImageId(
          ["image", "inspect", "--format", "{{.Id}}", images[serviceId] as string],
          context,
        );
        const containerId = (
          await runDocker([...composeArgs, "ps", "-q", serviceId], context)
        ).trim();
        if (!/^[a-f0-9]{12,64}$/.test(containerId) || !expected) return false;
        const running = await inspectImageId(
          ["container", "inspect", "--format", "{{.Image}}", containerId],
          context,
        );
        if (running !== expected) return false;
      }
      return true;
    });
  const restorePrevious = async (
    transaction: ReleaseTransaction,
    context: FixedCliOptions,
  ): Promise<void> => {
    await writeTransaction({ ...transaction, phase: "rollback_overlay" });
    if (transaction.previousOverlay === null) durableUnlink(paths.overlay);
    else atomicWrite(paths.overlay, transaction.previousOverlay);
    await writeTransaction({ ...transaction, phase: "rollback_services" });
    await runFixedCli(["services", "update", ...transaction.serviceIds], context);
    if (transaction.previousState === null) durableUnlink(paths.state);
    else atomicWrite(paths.state, transaction.previousState);
    durableUnlink(paths.transaction);
  };
  const completeForward = async (
    transaction: ReleaseTransaction,
    context: FixedCliOptions,
  ): Promise<void> => {
    const manifest = loadManifest(transaction.releaseId);
    // The transaction's digest was taken from the exact bytes authorized when
    // the apply was admitted. Reopening by release ID would otherwise let a
    // manifest replaced after admission drive the compose render, the service
    // update, and the published state under the same caller-visible ID.
    if (releaseDigest(canonicalReleaseManifest(manifest)) !== transaction.digest) {
      throw new Error("Release authority rejected");
    }
    if (transaction.phase === "prepared") {
      atomicWrite(paths.overlay, coreServices.renderReleaseCompose(manifest));
      transaction = { ...transaction, phase: "overlay_written" };
      await writeTransaction(transaction);
    }
    if (transaction.phase === "overlay_written") {
      atomicWrite(paths.overlay, coreServices.renderReleaseCompose(manifest));
      await runFixedCli(["services", "update", ...transaction.serviceIds], context);
      if (!(await verifyApplied(manifest, transaction.serviceIds, context))) {
        throw new Error("Release recovery verification failed");
      }
      transaction = { ...transaction, phase: "services_applied" };
      await writeTransaction(transaction);
    }
    if (transaction.phase === "services_applied") {
      // A reboot, container disappearance, digest drift, or an unreachable
      // Docker between the apply and this recovery would otherwise publish a
      // release the runtime is not actually running. `verifyApplied` reports
      // false for ambiguous and unavailable observations, so this fails closed
      // and leaves the transaction for a later attempt.
      if (!(await verifyApplied(manifest, transaction.serviceIds, context))) {
        throw new Error("Release recovery verification failed");
      }
      publishState(transaction);
      transaction = { ...transaction, phase: "state_published" };
      await writeTransaction(transaction);
    }
    if (transaction.phase === "state_published") {
      const state = readState();
      if (state.releaseId !== transaction.releaseId || state.digest !== transaction.digest) {
        throw new Error("Release recovery verification failed");
      }
      // The state pointer alone only proves what was written, not what runs.
      if (!(await verifyApplied(manifest, transaction.serviceIds, context))) {
        throw new Error("Release recovery verification failed");
      }
      durableUnlink(paths.transaction);
      return;
    }
    if (transaction.phase === "rollback_overlay" || transaction.phase === "rollback_services") {
      await restorePrevious(transaction, context);
    }
  };
  let initialization: Promise<void> | undefined;
  const initialize = (): Promise<void> => {
    initialization ??= (async () => {
      manifestNames();
      // Recovery reads the transaction and then reopens the manifest by release
      // ID. Holding the store lock across both keeps another agent process (or
      // a concurrent apply) from replacing those bytes in between, and makes
      // the digest recheck in `completeForward` a real boundary rather than a
      // second unsynchronized read.
      const lock = await acquireReleaseStoreLock(directory, releaseStoreLockHooks);
      try {
        const transaction = readTransaction();
        if (transaction) {
          await completeForward(transaction, {
            signal: new AbortController().signal,
            emitLog: () => undefined,
          });
        }
      } finally {
        lock.release();
      }
    })();
    return initialization;
  };
  return {
    initialize,
    resolve: async (context) => {
      await initialize();
      manifestNames();
      const image = coreServices.releaseManifestImage();
      await runDocker(["pull", image], context);
      const containerId = (await runDocker(["create", image, "true"], context)).trim();
      if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error("Release resolution failed");
      const temporaryDirectory = mkdtempSync(join(tmpdir(), "openmapx-agent-release-"));
      const temporaryManifest = join(temporaryDirectory, "release.json");
      try {
        await runDocker(
          [
            "cp",
            `${containerId}:${coreServices.RELEASE_MANIFEST_CONTAINER_PATH}`,
            temporaryManifest,
          ],
          context,
        );
        const raw = strictReadFile(temporaryManifest, MAX_RELEASE_MANIFEST_BYTES);
        const manifest = coreServices.parseReleaseManifest(raw);
        const canonical = canonicalReleaseManifest(manifest);
        const destination = releaseManifestPath(rootDir, manifest.release);
        // Re-read the store under the lock. A snapshot taken before the Docker
        // pull/create/cp awaits is stale, so two concurrent resolutions could
        // each observe the same sub-limit count and both publish past it.
        const lock = await acquireReleaseStoreLock(directory, releaseStoreLockHooks);
        try {
          const currentNames = manifestNames();
          if (
            !currentNames.includes(manifest.release) &&
            currentNames.length >= MAX_RELEASE_STORE_ENTRIES
          ) {
            throw new Error("Release store limit exceeded");
          }
          immutableWrite(destination, canonical);
          atomicWrite(
            paths.latest,
            JSON.stringify({ releaseId: manifest.release, digest: releaseDigest(canonical) }),
          );
        } finally {
          lock.release();
        }
        return manifest.release;
      } finally {
        await runDocker(["rm", "-f", containerId], context).catch(() => undefined);
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    },
    pull: async (releaseId, context) => {
      await initialize();
      const manifest = loadManifest(releaseId);
      for (const image of [
        manifest.images.api,
        manifest.images.web,
        manifest.images["data-manager"],
        manifest.images["ops-agent"],
        manifest.images["transitous-runner"],
        manifest.images["transitous-tools"],
      ]) {
        await runDocker(["pull", image], context);
      }
    },
    inspect: async () => {
      await initialize();
      return inspectRelease();
    },
    inspectSystem: async (context) => {
      await initialize();
      const release = await inspectRelease();
      const manifest = release.availableReleaseId
        ? loadManifest(release.availableReleaseId)
        : undefined;
      let dockerReachable = false;
      try {
        await runDocker(["info", "--format", "{{.ServerVersion}}"], context);
        dockerReachable = true;
      } catch {
        dockerReachable = false;
      }
      const composeArgs = [
        "compose",
        "-f",
        repositoryPaths.composeOutPath,
        ...(isRegularComposeFile(repositoryPaths.composeReleasePath)
          ? ["-f", repositoryPaths.composeReleasePath]
          : []),
      ];
      // Path existence alone is not readiness: a directory, an unreadable file,
      // or an unparseable document would all report ready and then fail every
      // later maintenance action. Validate through the Compose boundary itself.
      let composeReady = isRegularComposeFile(repositoryPaths.composeOutPath);
      if (composeReady && dockerReachable) {
        try {
          await runDocker([...composeArgs, "config", "-q"], context);
        } catch {
          composeReady = false;
        }
      } else if (composeReady) {
        composeReady = false;
      }
      const serviceImages = {
        "app-api": manifest?.images.api,
        "app-web": manifest?.images.web,
        "data-manager": manifest?.images["data-manager"],
      } as const;
      const services: OpsResultFor<"system.inspect">["services"] = [];
      for (const serviceId of ["app-api", "app-web", "data-manager"] as const) {
        const pinnedImage = serviceImages[serviceId];
        let containerId: string | undefined;
        // A thrown or unparseable `ps -q` is an absent observation, not an
        // observed-absent container. Only an exact empty result proves the
        // service is not running.
        let observed = false;
        if (dockerReachable && composeReady) {
          try {
            const value = (
              await runDocker([...composeArgs, "ps", "-q", serviceId], context)
            ).trim();
            if (value === "") observed = true;
            else if (/^[a-f0-9]{12,64}$/.test(value)) {
              containerId = value;
              observed = true;
            }
          } catch {
            observed = false;
          }
        }
        const runningImageId = containerId
          ? await inspectImageId(
              ["container", "inspect", "--format", "{{.Image}}", containerId],
              context,
            )
          : undefined;
        const localImageId = pinnedImage
          ? await inspectImageId(["image", "inspect", "--format", "{{.Id}}", pinnedImage], context)
          : undefined;
        const state =
          !dockerReachable || !composeReady || !pinnedImage || !observed
            ? "unknown"
            : !containerId
              ? "not_running"
              : !runningImageId || !localImageId
                ? "unknown"
                : runningImageId === localImageId
                  ? "current"
                  : "update_available";
        services.push({
          serviceId,
          containerState: !observed ? "unknown" : containerId ? "running" : "stopped",
          ...(pinnedImage ? { pinnedImage } : {}),
          ...(runningImageId ? { runningImageId } : {}),
          ...(localImageId ? { localImageId } : {}),
          releaseMember: pinnedImage !== undefined,
          state,
        });
      }
      return {
        dockerReachable,
        composeReady,
        maintenanceReady: dockerReachable && composeReady,
        release,
        services,
      };
    },
    apply: async (releaseId, serviceIds, context, updateJobId) => {
      await initialize();
      // Claiming the transaction is a read-then-write across processes. Without
      // the lock two agents can both observe no active transaction and both
      // write `transaction.json`, so the loser's rollback state is lost.
      const claimLock = await acquireReleaseStoreLock(directory, releaseStoreLockHooks);
      let manifest: ReturnType<typeof loadManifest>;
      let transaction: ReleaseTransaction;
      try {
        if (readTransaction()) throw new Error("Release transaction already active");
        manifest = loadManifest(releaseId);
        const previousOverlay = existsSync(paths.overlay)
          ? strictReadFile(paths.overlay, MAX_RELEASE_MANIFEST_BYTES)
          : null;
        const previousState = existsSync(paths.state)
          ? strictReadFile(paths.state, MAX_RELEASE_STATE_BYTES)
          : null;
        transaction = {
          version: 1,
          phase: "prepared",
          releaseId,
          digest: releaseDigest(canonicalReleaseManifest(manifest)),
          serviceIds: [...serviceIds],
          ...(updateJobId ? { updateJobId } : {}),
          previousOverlay,
          previousState,
        };
        await writeTransaction(transaction);
      } finally {
        claimLock.release();
      }
      atomicWrite(paths.overlay, coreServices.renderReleaseCompose(manifest));
      transaction = { ...transaction, phase: "overlay_written" };
      await writeTransaction(transaction);
      try {
        await runFixedCli(["services", "update", ...serviceIds], context);
        if (!(await verifyApplied(manifest, serviceIds, context))) {
          throw new Error("Release application verification failed");
        }
      } catch (error) {
        await restorePrevious(transaction, context);
        throw error;
      }
      transaction = { ...transaction, phase: "services_applied" };
      await writeTransaction(transaction);
      publishState(transaction);
      transaction = { ...transaction, phase: "state_published" };
      await writeTransaction(transaction);
      durableUnlink(paths.transaction);
    },
    runtimeInspect: async () => {
      await initialize();
      const state = readState();
      return {
        ...(state.releaseId ? { releaseId: state.releaseId } : {}),
        ...(state.updateJobId ? { updateJobId: state.updateJobId } : {}),
      };
    },
  };
}

export function createDefaultFixedCli(_rootDir: string): FixedCliRunner {
  const runtimeRoot = join(import.meta.dirname, "..", "..", "..");
  const executable = join(runtimeRoot, "packages", "cli", "node_modules", ".bin", "tsx");
  const tsconfig = join(runtimeRoot, "packages", "cli", "tsconfig.json");
  const entrypoint = join(runtimeRoot, "packages", "cli", "src", "index.ts");
  return async (args, options) => {
    const result = await runContainedProcess(
      executable,
      ["--tsconfig", tsconfig, entrypoint, ...args],
      {
        signal: options.signal,
        timeout: MAX_CLI_DURATION_MS,
        maxBuffer: MAX_CLI_OUTPUT_BYTES,
      },
    );
    emitLines(options.emitLog, "stdout", result.stdout);
    emitLines(options.emitLog, "stderr", result.stderr);
  };
}

export function createAdministrativeRuntime(
  runtime: OpsRuntime,
  options: AdministrativeRuntimeOptions,
): OpsRuntime {
  const runFixedCli = options.runFixedCli ?? createDefaultFixedCli(options.rootDir);
  const releaseEffects =
    options.releaseEffects ?? createDefaultReleaseEffects(options.rootDir, runFixedCli);
  const loadBuildAuthority = options.loadBuildAuthority ?? (async () => []);
  const buildArgs = (serviceId: string, regionId?: string): string[] => [
    "services",
    "build",
    serviceId,
    ...(regionId ? ["--region", regionId] : []),
  ];
  const loadBuildable = async (): Promise<BuildAuthorityService[]> => {
    const authority = [...(await loadBuildAuthority())];
    if (authority.length > 256) throw new Error("Build authority rejected");
    const seen = new Set<string>();
    for (const service of authority) {
      if (!SERVICE_ID.test(service.serviceId) || seen.has(service.serviceId)) {
        throw new Error("Build authority rejected");
      }
      seen.add(service.serviceId);
    }
    return authority
      .filter(
        (service) =>
          service.enabled &&
          service.isBuiltIn &&
          typeof service.buildCommand === "string" &&
          service.buildCommand.length > 0,
      )
      .sort((left, right) => left.serviceId.localeCompare(right.serviceId));
  };
  runtime["service.build"] = async (operation, context) => {
    const buildable = await loadBuildable();
    if (!buildable.some((service) => service.serviceId === operation.serviceId)) {
      throw new Error("Build authority rejected");
    }
    await runFixedCli(buildArgs(operation.serviceId, operation.regionId), context);
    return { completed: true };
  };
  runtime["services.buildAll"] = async (operation, context) => {
    const completedServiceIds: string[] = [];
    const failedServiceIds: string[] = [];
    for (const service of await loadBuildable()) {
      if (context.signal.aborted) throw new DOMException("Aborted", "AbortError");
      try {
        await runFixedCli(buildArgs(service.serviceId, operation.regionId), context);
        completedServiceIds.push(service.serviceId);
      } catch (error) {
        failedServiceIds.push(service.serviceId);
        if (operation.failFast) throw error;
      }
    }
    return { completedServiceIds, failedServiceIds };
  };
  runtime["backup.list"] = async () => inspectBackupInventory(options.rootDir);
  runtime["backup.create"] = async (operation, context) => {
    await runFixedCli(["backup", "create", "--name", operation.backupId], {
      signal: context.signal,
      emitLog: context.emitLog,
    });
    return { backupId: operation.backupId };
  };
  runtime["backup.restore"] = async (operation, context) => {
    // Authorization validated a manifest, but the CLI reopens the backup by ID.
    // Hold the backup-store lock across the whole effect and revalidate the
    // exact bytes immediately before dispatch, so a manifest replaced between
    // the resource claim and the effect cannot supply different service
    // authority under the same caller-visible backup ID.
    const lock = await acquireBackupStoreLock(options.rootDir);
    try {
      const digest = inspectBackupManifestDigest(options.rootDir, operation.backupId);
      if (digest === null) throw new Error("Backup authority rejected");
      const manifest = parseManifest(options.rootDir, operation.backupId);
      const available = new Set(manifest.services.map((service) => service.id));
      if (!(operation.serviceIds ?? []).every((serviceId) => available.has(serviceId))) {
        throw new Error("Backup authority rejected");
      }
      await runFixedCli(
        [
          "backup",
          "restore",
          operation.backupId,
          ...(operation.serviceIds?.length ? ["--services", ...operation.serviceIds] : []),
          ...(operation.stopRunning ? ["--stop-running"] : []),
        ],
        { signal: context.signal, emitLog: context.emitLog },
      );
      if (inspectBackupManifestDigest(options.rootDir, operation.backupId) !== digest) {
        throw new Error("Backup authority rejected");
      }
    } finally {
      lock.release();
    }
    return { backupId: operation.backupId };
  };
  runtime["backup.delete"] = async (operation, context) => {
    const lock = await acquireBackupStoreLock(options.rootDir);
    try {
      await runFixedCli(["backup", "delete", operation.backupId], {
        signal: context.signal,
        emitLog: context.emitLog,
      });
    } finally {
      lock.release();
    }
    return { backupId: operation.backupId };
  };
  runtime["data.inspect"] = async () => inspectDataInventory(options.rootDir);
  runtime["data.downloadOsm"] = async (operation, context) => {
    await runFixedCli(
      ["data", "download", "osm", ...(operation.regionId ? [operation.regionId] : [])],
      { signal: context.signal, emitLog: context.emitLog },
    );
    return { completed: true, ...(operation.regionId ? { resourceId: operation.regionId } : {}) };
  };
  runtime["data.downloadFonts"] = async (_operation, context) => {
    await runFixedCli(["data", "download", "fonts"], {
      signal: context.signal,
      emitLog: context.emitLog,
    });
    return { completed: true };
  };
  runtime["data.update"] = async (operation, context) => {
    await runFixedCli(
      [
        "data",
        "update",
        ...(operation.regionId ? [operation.regionId] : []),
        ...(operation.countryCodes?.length
          ? ["--countries", operation.countryCodes.join(",")]
          : []),
        ...(operation.failFast ? ["--fail-fast"] : []),
      ],
      { signal: context.signal, emitLog: context.emitLog },
    );
    return { completed: true, ...(operation.regionId ? { resourceId: operation.regionId } : {}) };
  };
  runtime["data.convertOverpass"] = async (operation, context) => {
    await runFixedCli(
      ["data", "convert", "overpass", ...(operation.regionId ? [operation.regionId] : [])],
      { signal: context.signal, emitLog: context.emitLog },
    );
    return { completed: true, ...(operation.regionId ? { resourceId: operation.regionId } : {}) };
  };
  runtime["data.link"] = async (_operation, context) => {
    await runFixedCli(["data", "link"], {
      signal: context.signal,
      emitLog: context.emitLog,
    });
    return { completed: true };
  };
  runtime["data.clean"] = async (operation, context) => {
    await runFixedCli(["data", "clean", operation.dataTypeId], {
      signal: context.signal,
      emitLog: context.emitLog,
    });
    return { completed: true, resourceId: operation.dataTypeId };
  };
  runtime["data.generateApiKeys"] = async (_operation, context) => {
    await runFixedCli(["data", "generate-api-keys"], {
      signal: context.signal,
      emitLog: context.emitLog,
    });
    return { completed: true };
  };
  runtime["data.overtureSync"] = async (operation, context) => {
    await runFixedCli(["data", "overture-sync", operation.regionId], {
      signal: context.signal,
      emitLog: context.emitLog,
    });
    return { completed: true, resourceId: operation.regionId };
  };
  runtime["data.overtureConflate"] = async (operation, context) => {
    await runFixedCli(
      [
        "data",
        "overture-conflate",
        operation.regionId,
        ...(operation.restart ? ["--restart"] : []),
      ],
      { signal: context.signal, emitLog: context.emitLog },
    );
    return { completed: true, resourceId: operation.regionId };
  };
  runtime["data.searchIndexBuild"] = async (operation, context) => {
    await runFixedCli(["data", "search-index", "build", operation.regionId], {
      signal: context.signal,
      emitLog: context.emitLog,
    });
    return { completed: true, resourceId: operation.regionId };
  };
  runtime["system.diagnostics"] = async (_operation, context) => {
    await runFixedCli(["check"], {
      signal: context.signal,
      emitLog: context.emitLog,
    });
    return { ok: true, checks: [] };
  };
  runtime["system.inspect"] = async (_operation, context) => releaseEffects.inspectSystem(context);
  runtime["release.resolve"] = async (_operation, context) => ({
    releaseId: await releaseEffects.resolve(context),
  });
  runtime["release.pull"] = async (operation, context) => {
    await releaseEffects.pull(operation.releaseId, context);
    return { releaseId: operation.releaseId };
  };
  runtime["release.inspect"] = async () => releaseEffects.inspect();
  runtime["release.apply"] = async (operation, context) => {
    await releaseEffects.apply(
      operation.releaseId,
      ["data-manager", "app-web", "app-api"],
      context,
    );
    return { releaseId: operation.releaseId };
  };
  runtime["appApi.replace"] = async (operation, context) => {
    await releaseEffects.apply(operation.releaseId, ["app-api"], context, operation.updateJobId);
    return { updateJobId: operation.updateJobId, replaced: true };
  };
  runtime["appApi.runtime.inspect"] = async () => releaseEffects.runtimeInspect?.() ?? {};
  runtime["system.update"] = async (operation, context) => {
    if (operation.createBackup && operation.backupId) {
      await runFixedCli(["backup", "create", "--name", operation.backupId], context);
    }
    await releaseEffects.pull(operation.releaseId, context);
    await releaseEffects.apply(
      operation.releaseId,
      ["data-manager", "app-web", "app-api"],
      context,
    );
    return { releaseId: operation.releaseId };
  };
  return runtime;
}
