import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  OPS_MAX_BACKUP_ID_LENGTH,
  OPS_MAX_BACKUP_INVENTORY_ENTRIES,
  OPS_PUBLIC_ERROR_MESSAGES,
  type OpsResultFor,
} from "@openmapx/core/ops";
import { atomicWrite, durableUnlink, fsyncDirectory } from "@openmapx/core/release-files";
import { services as coreServices } from "@openmapx/core/server";
import {
  advanceAgentHandoff,
  agentHandoffRunArgs,
  inspectAgentContainer,
  isTerminalHandoff,
  readAgentHandoff,
  reconcileAgentHandoff,
  writeAgentHandoff,
} from "./agent-handoff";
import { inspectDataInventory } from "./data-inventory";
import {
  hashDescriptorAnchoredFile,
  listDescriptorAnchoredDirectory,
  readDescriptorAnchoredUtf8,
} from "./descriptor-file";
import { runContainedProcess } from "./docker-runtime";
import { strictReadFile } from "./durable-files";
import { createImageInspection } from "./release-images";
import {
  OpsAgentBusyError,
  type OpsExecutionContext,
  OpsHostUpdateRequiredError,
  type OpsRuntime,
} from "./runtime";

const { acquireStoreLock, acquireReleaseStoreLock, RELEASE_STORE_LOCK_NAME } = coreServices;
type ReleaseStoreLock = coreServices.ReleaseStoreLock;
type ReleaseStoreLockHooks = coreServices.ReleaseStoreLockHooks;

const MAX_BACKUP_MANIFEST_BYTES = 1024 * 1024;
const MAX_BACKUP_SERVICES = 256;
const MAX_BACKUP_VOLUMES = 4_096;
const MAX_CLI_OUTPUT_BYTES = 1024 * 1024;
const MAX_CLI_DURATION_MS = 30 * 60_000;
const ADMIN_RELEASE_SERVICE_IDS = [
  "data-manager",
  "app-web",
  "transitous-runner",
  "app-api",
] as const;
const INSPECT_RELEASE_SERVICE_IDS = [
  "app-api",
  "app-web",
  "data-manager",
  "ops-agent",
  "transitous-runner",
] as const;
const MAX_RELEASE_MANIFEST_BYTES = coreServices.RELEASE_STORE_LIMITS.manifestBytes;
const MAX_RELEASE_STATE_BYTES = coreServices.RELEASE_STORE_LIMITS.stateBytes;
const MAX_RELEASE_TRANSACTION_BYTES = coreServices.RELEASE_STORE_LIMITS.transactionBytes;
const MAX_RELEASE_SELECTIONS_BYTES = coreServices.RELEASE_STORE_LIMITS.selectionsBytes;
const MAX_RELEASE_STORE_ENTRIES = coreServices.RELEASE_STORE_LIMITS.entries;
const BACKUP_STORE_LOCK_NAME = ".backup-store.lock";
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

interface FixedCliOptions {
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

interface BuildAuthorityService {
  serviceId: string;
  enabled: boolean;
  isBuiltIn: boolean;
  buildCommand?: string;
}

export interface AdministrativeReleaseEffects {
  initialize?(): Promise<void>;
  resolve(context: FixedCliOptions): Promise<string>;
  pull(releaseId: string, context: FixedCliOptions): Promise<void>;
  inspect(): Promise<OpsResultFor<"release.inspect">>;
  validateCandidate?(releaseId: string, expectedDigest: string): Promise<void>;
  inspectSystem(context: FixedCliOptions): Promise<OpsResultFor<"system.inspect">>;
  apply(
    releaseId: string,
    serviceIds: readonly [string, ...string[]],
    context: FixedCliOptions,
    updateJobId?: string,
  ): Promise<void>;
  runtimeInspect?(): Promise<{ releaseId?: string; updateJobId?: string }>;
  updateAgent?(
    request: {
      releaseId: string;
      expectedDigest: string;
      handoffId: string;
      otherActiveOperations: number;
    },
    context: FixedCliOptions,
  ): Promise<OpsResultFor<"agent.update">>;
  inspectAgentHandoff?(handoffId: string): Promise<OpsResultFor<"agent.handoff.inspect">>;
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
  /** Runs after an inspection settled a handoff whose helper had exited. */
  afterHandoffSettled?: () => Promise<void>;
  /** The uid the release state must belong to; the effective uid unless a test injects one. */
  uid?: number;
  /** Receives what the startup migration of an earlier release's state carried over. */
  onLegacyReleaseMigration?: (migration: coreServices.LegacyReleaseStateMigration) => void;
}

type ReleaseTransactionPhase =
  | "prepared"
  | "overlay_written"
  | "services_applied"
  | "state_published"
  | "rollback_overlay"
  | "rollback_services";

export interface ParsedBackupManifest {
  name: string;
  createdAt: string;
  openmapxVersion: string;
  formatVersion: 2;
  manifestDigest: string;
  services: Array<{
    id: string;
    version: string;
    volumes: Array<{
      name: string;
      file: string;
      mode: "tar" | "pg_dump";
      sizeBytes: number;
      sha256: string;
    }>;
  }>;
  privacySourceProvenance?: {
    managedDawarich?: {
      version: string;
      image: string;
      imageDigest: string;
      upstreamCommit: string;
      schemaContract: string;
    };
  };
}

export interface VerifiedPrivacyBackupInput {
  serviceId: string;
  volumeId: string;
  file: string;
  mode: "tar" | "pg_dump";
  sizeBytes: number;
  sha256: string;
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

/**
 * Backup reads are anchored here, at the directory rendering creates owner-only,
 * not at the checkout root: git leaves the checkout's own directories
 * group-writable under a umask of 002, and they hold no backup.
 */
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
  let contents: string;
  try {
    contents = readDescriptorAnchoredUtf8(backupRoot(rootDir), [backupId, "manifest.json"], {
      minimumBytes: 1,
      maximumBytes: MAX_BACKUP_MANIFEST_BYTES,
    });
    candidate = JSON.parse(contents);
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
  if (raw.formatVersion !== 2) throw new Error("Backup authority rejected");
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
      const rawVolume = entry as Record<string, unknown>;
      const sizeBytes = rawVolume.sizeBytes;
      if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
        throw new Error("Backup authority rejected");
      }
      const name = rawVolume.name;
      const file = rawVolume.file;
      const mode = rawVolume.mode;
      const sha256 = rawVolume.sha256;
      const resolvedName = rawVolume.resolvedName;
      const postgresUser = rawVolume.postgresUser;
      const postgresDb = rawVolume.postgresDb;
      if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(name)) {
        throw new Error("Backup authority rejected");
      }
      if (mode !== "tar" && mode !== "pg_dump") throw new Error("Backup authority rejected");
      if (typeof file !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(file))
        throw new Error("Backup authority rejected");
      if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) {
        throw new Error("Backup authority rejected");
      }
      if (
        mode === "tar" &&
        (typeof resolvedName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(resolvedName))
      ) {
        throw new Error("Backup authority rejected");
      }
      if (
        mode === "pg_dump" &&
        (typeof postgresUser !== "string" ||
          !coreServices.isSafePostgresIdentifier(postgresUser) ||
          typeof postgresDb !== "string" ||
          !coreServices.isSafePostgresIdentifier(postgresDb))
      ) {
        throw new Error("Backup authority rejected");
      }
      return {
        name,
        file,
        mode: mode as "tar" | "pg_dump",
        sizeBytes,
        sha256,
      };
    });
    return { id: service.id, version: service.version, volumes };
  });
  const provenance = raw.privacySourceProvenance as
    | ParsedBackupManifest["privacySourceProvenance"]
    | undefined;
  const managed = provenance?.managedDawarich;
  if (
    managed &&
    (managed.version !== "1.15.3" ||
      managed.image !== "freikin/dawarich" ||
      managed.imageDigest !==
        "sha256:589e3606b11b61c3fa2d9661832cb73645a9b93a9cc7d807a071e2bc6c584498" ||
      managed.upstreamCommit !== "e32b70701b2467b862d4b5bc27ac428999997c1b" ||
      managed.schemaContract !== "dawarich-1.15.3")
  )
    throw new Error("Backup authority rejected");
  return {
    name: backupId,
    createdAt: new Date(raw.createdAt).toISOString(),
    openmapxVersion: raw.openmapxVersion,
    formatVersion: 2,
    manifestDigest: createHash("sha256").update(contents).digest("hex"),
    services,
    ...(managed ? { privacySourceProvenance: { managedDawarich: managed } } : {}),
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
  const entries = listDescriptorAnchoredDirectory(backupRoot(rootDir), [], {
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
      const children = listDescriptorAnchoredDirectory(backupRoot(rootDir), [entry.name], {
        maximumEntries: MAX_BACKUP_VOLUMES + 1,
      });
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
    const volumeDetails = manifest.services.flatMap((service) =>
      service.volumes.map((volume) => ({
        serviceId: service.id,
        volumeId: volume.name,
        mode: volume.mode,
        sizeBytes: volume.sizeBytes,
        sha256: volume.sha256,
      })),
    );
    let verified = true;
    if (verified) {
      for (const service of manifest.services) {
        for (const volume of service.volumes) {
          try {
            const measured = hashDescriptorAnchoredFile(
              backupRoot(rootDir),
              [entry.name, volume.file],
              {
                maximumBytes: Number.MAX_SAFE_INTEGER,
                expectedBytes: volume.sizeBytes,
                expectedSha256: volume.sha256,
              },
            );
            if (measured.sizeBytes !== volume.sizeBytes || measured.sha256 !== volume.sha256)
              verified = false;
          } catch {
            verified = false;
          }
          if (!verified) break;
        }
        if (!verified) break;
      }
    }
    backups.push({
      backupId: entry.name,
      createdAt: manifest.createdAt,
      platformVersion: manifest.openmapxVersion,
      manifestDigest: manifest.manifestDigest,
      formatVersion: manifest.formatVersion,
      verified,
      volumes: volumeDetails,
      serviceCount: manifest.services.length,
      volumeCount: volumeDetails.length,
      totalBytes: volumeDetails.reduce((total, volume) => total + volume.sizeBytes, 0),
    });
  }
  backups.sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) || left.backupId.localeCompare(right.backupId),
  );
  return { backups, warningCount };
}

/**
 * Re-open one format-2 backup and verify every declared member while the
 * caller's backup-store lease is held. This helper is intentionally scoped to
 * the ops process: its returned filenames are never serialized through the
 * public inventory or privacy API.
 */
export function readVerifiedPrivacyBackupInputs(
  rootDir: string,
  backupId: string,
  expectedManifestDigest: string,
): { manifest: ParsedBackupManifest; inputs: VerifiedPrivacyBackupInput[] } {
  assertBackupId(backupId);
  if (!/^[a-f0-9]{64}$/.test(expectedManifestDigest)) throw new Error("Backup authority rejected");
  const manifest = parseManifest(rootDir, backupId);
  if (manifest.manifestDigest !== expectedManifestDigest) {
    throw new Error("Backup authority rejected");
  }
  const inputs: VerifiedPrivacyBackupInput[] = [];
  for (const service of manifest.services) {
    for (const volume of service.volumes) {
      const measured = hashDescriptorAnchoredFile(backupRoot(rootDir), [backupId, volume.file], {
        maximumBytes: Number.MAX_SAFE_INTEGER,
        expectedBytes: volume.sizeBytes,
        expectedSha256: volume.sha256,
      });
      if (measured.sizeBytes !== volume.sizeBytes || measured.sha256 !== volume.sha256) {
        throw new Error("Backup authority rejected");
      }
      inputs.push({
        serviceId: service.id,
        volumeId: volume.name,
        file: volume.file,
        mode: volume.mode,
        sizeBytes: volume.sizeBytes,
        sha256: volume.sha256,
      });
    }
  }
  return { manifest, inputs };
}

export async function inspectPrivacyBackupLease(
  rootDir: string,
  backupId: string,
  expectedManifestDigest: string,
  signal: AbortSignal,
): Promise<{
  backupId: string;
  manifestDigest: string;
  platformVersion: string;
  formatVersion: 2;
  verified: true;
  release: () => void;
}> {
  if (signal.aborted) throw new Error("backup inspection aborted");
  const lock = await acquireBackupStoreLock(rootDir);
  try {
    if (signal.aborted) throw new Error("backup inspection aborted");
    const verified = readVerifiedPrivacyBackupInputs(rootDir, backupId, expectedManifestDigest);
    return {
      backupId,
      manifestDigest: verified.manifest.manifestDigest,
      platformVersion: verified.manifest.openmapxVersion,
      formatVersion: 2,
      verified: true,
      release: lock.release,
    };
  } catch (error) {
    lock.release();
    throw error;
  }
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
    const entries = listDescriptorAnchoredDirectory(backupRoot(rootDir), [], {
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

function infraDirectory(rootDir: string): string {
  return join(rootDir, "infra", "docker");
}

/** The agent's release store, `state/ops-agent/releases/store`. */
function releaseDirectory(rootDir: string): string {
  return coreServices.releaseStatePaths(infraDirectory(rootDir)).store;
}

function releaseManifestPath(rootDir: string, releaseId: string): string {
  if (!coreServices.RELEASE_ID_PATTERN.test(releaseId)) {
    throw new Error("Release authority rejected");
  }
  return join(releaseDirectory(rootDir), `${releaseId}.json`);
}

function stateOwner(uid?: number): number | undefined {
  return uid ?? process.geteuid?.();
}

/**
 * Every entry of the release store is the agent's own: a regular file of its
 * uid with one link and no group or other write, within its size bound.
 */
function assertStoreEntry(path: string, maximum: number, uid: number | undefined): void {
  const stat = lstatSync(path);
  if (stat.size < 1 || coreServices.releaseStateFileProblem(stat, maximum, { uid }) !== null) {
    throw new Error("Release store contains an unsafe entry");
  }
}

export function inspectReleaseAuthority(rootDir: string, releaseId: string): boolean {
  try {
    const manifest = coreServices.parseReleaseManifest(
      strictReadFile(releaseManifestPath(rootDir, releaseId), MAX_RELEASE_MANIFEST_BYTES, {
        owner: stateOwner(),
      }),
    );
    return manifest.release === releaseId;
  } catch {
    return false;
  }
}

function releaseDigest(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function immutableWrite(path: string, contents: string, owner: number | undefined): void {
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
        if (strictReadFile(path, MAX_RELEASE_MANIFEST_BYTES, { owner }) !== contents) {
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

function acquireBackupStoreLock(rootDir: string): Promise<ReleaseStoreLock> {
  const root = backupRoot(rootDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return acquireStoreLock(root, BACKUP_STORE_LOCK_NAME);
}

export async function pruneBackupRetention(
  rootDir: string,
  retentionDays: number,
  runFixedCli: FixedCliRunner,
): Promise<void> {
  if (!Number.isSafeInteger(retentionDays) || retentionDays <= 0 || retentionDays > 36_500) {
    throw new Error("Backup retention days must be an integer between 1 and 36500");
  }
  const lock = await acquireBackupStoreLock(rootDir);
  try {
    await runFixedCli(["backup", "prune", "--retention-days", String(retentionDays)], {
      signal: new AbortController().signal,
      emitLog: () => {},
    });
  } finally {
    lock.release();
  }
}

/**
 * Digest of the exact canonical backup-manifest bytes, or null when the backup
 * is absent or unreadable. Used to prove that the bytes an effect acts on are
 * the bytes that were authorized.
 */
function inspectBackupManifestDigest(rootDir: string, backupId: string): string | null {
  try {
    assertBackupId(backupId);
    const raw = readDescriptorAnchoredUtf8(backupRoot(rootDir), [backupId, "manifest.json"], {
      minimumBytes: 1,
      maximumBytes: MAX_BACKUP_MANIFEST_BYTES,
    });
    return createHash("sha256").update(raw).digest("hex");
  } catch {
    return null;
  }
}

function releaseStoreBindings(
  rootDir: string,
  hooks: ReleaseStoreLockHooks = {},
  uid: number | undefined = stateOwner(),
) {
  const directory = releaseDirectory(rootDir);
  const infraDir = infraDirectory(rootDir);
  const repositoryPaths: coreServices.StackPaths = {
    infraDir,
    composePath: coreServices.currentConfigurationFile(
      infraDir,
      coreServices.GENERATED_COMPOSE_FILE,
    ),
    composeReleasePath: coreServices.releaseStatePaths(infraDir).overlay,
  };
  const overlay = repositoryPaths.composeReleasePath;
  // Owner and mode are checked as for the store: an overlay someone else could
  // write is refused, not read and not passed to Compose.
  const readOverlay = () => coreServices.readReleaseOverlay(infraDir, { uid });
  return {
    repositoryPaths,
    stackArgs: () =>
      coreServices.stackComposeArgs(repositoryPaths, (path) =>
        path === overlay ? readOverlay() !== null : isRegularComposeFile(path),
      ),
    readOverlay,
    restoreOverlay: (previousOverlay: string | null) => {
      if (previousOverlay === null) durableUnlink(overlay);
      else atomicWrite(overlay, previousOverlay);
    },
    withStoreLock: async <T>(action: () => T): Promise<T> => {
      const lock = await acquireReleaseStoreLock(directory, hooks);
      try {
        return action();
      } finally {
        lock.release();
      }
    },
  };
}

/** Release-store access for the agent replacement helper, which runs outside the agent. */
export function createAgentHandoffBindings(rootDir: string, options: { uid?: number } = {}) {
  const uid = stateOwner(options.uid);
  const bindings = releaseStoreBindings(rootDir, {}, uid);
  const loadStored = (releaseId: string, digest: string) => {
    const raw = strictReadFile(
      releaseManifestPath(rootDir, releaseId),
      MAX_RELEASE_MANIFEST_BYTES,
      {
        owner: uid,
      },
    );
    const manifest = coreServices.parseReleaseManifest(raw);
    if (
      manifest.release !== releaseId ||
      raw !== coreServices.canonicalReleaseManifest(manifest) ||
      releaseDigest(raw) !== digest
    ) {
      throw new Error("Release authority rejected");
    }
    return manifest;
  };
  return {
    stackArgs: bindings.stackArgs,
    restoreOverlay: bindings.restoreOverlay,
    withStoreLock: bindings.withStoreLock,
    releasePins: (releaseId: string, digest: string) => {
      const manifest = loadStored(releaseId, digest);
      return {
        agentImage: manifest.images["ops-agent"],
        helperImage: manifest.images["privacy-backup"],
      };
    },
    writeOverlay: (releaseId: string, digest: string) =>
      coreServices.writeReleaseComposeArtifacts(
        loadStored(releaseId, digest),
        bindings.repositoryPaths.infraDir,
        { uid },
      ),
  };
}

export function createDefaultReleaseEffects(
  rootDir: string,
  runFixedCli: FixedCliRunner,
  runtimeOptions: AdministrativeReleaseRuntimeOptions = {},
): AdministrativeReleaseEffects {
  const infraDir = infraDirectory(rootDir);
  const uid = stateOwner(runtimeOptions.uid);
  // `releases/`, `store/` and `evidence/`: created owner-only when missing,
  // refused when they are anyone else's. Nothing is read before the legacy
  // migration in `initialize`.
  const { store: directory, overlay } = coreServices.ensureReleaseStateDirectories(infraDir, {
    uid,
  });
  const releaseStoreLockHooks = runtimeOptions.releaseStoreLockHooks ?? {};
  const paths = {
    overlay,
    state: join(directory, "current.json"),
    latest: join(directory, "latest.json"),
    transaction: join(directory, "transaction.json"),
    selections: join(directory, "selections.json"),
  };
  const { repositoryPaths, stackArgs, restoreOverlay, withStoreLock, readOverlay } =
    releaseStoreBindings(rootDir, releaseStoreLockHooks, uid);
  const manifestNames = () => {
    const entries = readdirSync(directory);
    if (entries.length > MAX_RELEASE_STORE_ENTRIES + 5)
      throw new Error("Release store limit exceeded");
    let bytes = 0;
    const names: string[] = [];
    for (const name of entries) {
      // The lock is agent-owned coordination state, not a stored release.
      if (name === RELEASE_STORE_LOCK_NAME) {
        const stat = lstatSync(join(directory, name));
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          (uid !== undefined && stat.uid !== uid) ||
          (stat.mode & 0o022) !== 0
        ) {
          throw new Error("Release store contains an unsafe entry");
        }
        continue;
      }
      if ((coreServices.RELEASE_STORE_POINTER_FILES as readonly string[]).includes(name)) {
        const maximum =
          name === "transaction.json"
            ? MAX_RELEASE_TRANSACTION_BYTES
            : name === "selections.json"
              ? MAX_RELEASE_SELECTIONS_BYTES
              : MAX_RELEASE_STATE_BYTES;
        assertStoreEntry(join(directory, name), maximum, uid);
        continue;
      }
      const match = coreServices.RELEASE_MANIFEST_FILE_PATTERN.exec(name);
      if (!match) throw new Error("Release store contains an unsafe entry");
      const path = join(directory, name);
      assertStoreEntry(path, MAX_RELEASE_MANIFEST_BYTES, uid);
      const stat = lstatSync(path);
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
    const raw = strictReadFile(
      releaseManifestPath(rootDir, releaseId),
      MAX_RELEASE_MANIFEST_BYTES,
      {
        owner: uid,
      },
    );
    const manifest = coreServices.parseReleaseManifest(raw);
    if (manifest.release !== releaseId || raw !== coreServices.canonicalReleaseManifest(manifest)) {
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
      return args[0] === "pull" ? `${result.stdout}\n${result.stderr}` : result.stdout;
    });
  const readReleasePointer = (
    path: string,
    optional: boolean,
  ): { releaseId?: string; updateJobId?: string; digest?: string } => {
    try {
      const stat = lstatSync(path);
      if (coreServices.releaseStateFileProblem(stat, MAX_RELEASE_STATE_BYTES, { uid }) !== null) {
        throw new Error("Release authority rejected");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && optional) return {};
      throw new Error("Release authority rejected");
    }
    const value = coreServices.parseReleasePointer(
      strictReadFile(path, MAX_RELEASE_STATE_BYTES, { owner: uid }),
      path === paths.latest,
    );
    const manifest = loadManifest(value.releaseId);
    const digest = releaseDigest(coreServices.canonicalReleaseManifest(manifest));
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
  /**
   * The overlay of the release the agent last applied, from its own release
   * store. A handoff imported from an earlier release's state location keeps
   * no previous overlay, because data-manager could write that file; this is
   * its rollback target instead. Without a recorded release it is the current
   * overlay, which leaves the application services where they are.
   */
  const releaseStateOverlay = (): string | null => {
    try {
      const { releaseId } = readState();
      if (releaseId) return coreServices.renderReleaseCompose(loadManifest(releaseId), infraDir);
    } catch {
      // Unreadable release state: no derived target.
    }
    return readOverlay();
  };
  const configurationIdentity = () =>
    releaseDigest(JSON.stringify(coreServices.releaseSelection()));
  const selectionReceipts = (): coreServices.ReleaseSelectionReceipts => {
    if (!existsSync(paths.selections)) return {};
    return coreServices.parseReleaseSelectionReceipts(
      strictReadFile(paths.selections, MAX_RELEASE_SELECTIONS_BYTES, { owner: uid }),
    );
  };
  const validateCandidate = async (releaseId: string, expectedDigest: string) => {
    const manifest = loadManifest(releaseId);
    const receipt = selectionReceipts()[releaseId];
    if (
      !receipt ||
      receipt.configuration !== configurationIdentity() ||
      receipt.digest !== expectedDigest ||
      releaseDigest(coreServices.canonicalReleaseManifest(manifest)) !== expectedDigest
    )
      throw new Error(
        "Checked release is unavailable, changed or belongs to another configuration; check again",
      );
    coreServices.validateResolvedSelection(
      coreServices.releaseSelection(),
      manifest,
      receipt.ociDigest,
    );
  };
  const inspectRelease = async (): Promise<OpsResultFor<"release.inspect">> => {
    const state = readState();
    const latest = readReleasePointer(paths.latest, true);
    const candidates = manifestNames();
    const availableReleaseId =
      latest.releaseId ?? (candidates.length === 1 ? candidates[0] : undefined);
    const current = state.releaseId ? loadManifest(state.releaseId) : undefined;
    const available = availableReleaseId ? loadManifest(availableReleaseId) : undefined;
    const receipt = availableReleaseId ? selectionReceipts()[availableReleaseId] : undefined;
    return {
      configuredSelector: process.env.OPENMAPX_RELEASE ?? "main",
      ...(state.releaseId ? { currentReleaseId: state.releaseId } : {}),
      ...(current?.product ? { currentVersion: current.product.version } : {}),
      ...(availableReleaseId ? { availableReleaseId } : {}),
      ...(available?.product ? { availableVersion: available.product.version } : {}),
      ...(receipt && receipt.configuration === configurationIdentity()
        ? { availableDigest: receipt.digest }
        : {}),
    };
  };
  const { inspectImageId, observePinnedImage, inspectAgentHelper, agentMatchesRelease } =
    createImageInspection(runDocker);
  const agentPins = (manifest: ReturnType<typeof coreServices.parseReleaseManifest>) => ({
    agentImage: manifest.images["ops-agent"],
    helperImage: manifest.images["privacy-backup"],
  });
  const agentContainerId = async (context: FixedCliOptions): Promise<string | undefined> => {
    const value = (await runDocker([...stackArgs(), "ps", "-q", "ops-agent"], context)).trim();
    return /^[a-f0-9]{12,64}$/.test(value) ? value : undefined;
  };
  const requireCurrentAgent = async (
    manifest: ReturnType<typeof coreServices.parseReleaseManifest>,
    context: FixedCliOptions,
  ): Promise<void> => {
    let matches = false;
    try {
      const containerId = await agentContainerId(context);
      matches =
        containerId !== undefined &&
        (await agentMatchesRelease(containerId, agentPins(manifest), context));
    } catch {
      /* Unknown state must not permit a partial system update. */
    }
    if (!matches) {
      context.emitLog("stderr", OPS_PUBLIC_ERROR_MESSAGES.host_update_required);
      throw new OpsHostUpdateRequiredError();
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
      if (
        coreServices.releaseStateFileProblem(stat, MAX_RELEASE_TRANSACTION_BYTES, { uid }) !== null
      ) {
        throw new Error("Release transaction rejected");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("Release transaction rejected");
    }
    const raw = strictReadFile(paths.transaction, MAX_RELEASE_TRANSACTION_BYTES, { owner: uid });
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
      value.serviceIds.length > ADMIN_RELEASE_SERVICE_IDS.length ||
      value.serviceIds.some(
        (serviceId) =>
          typeof serviceId !== "string" ||
          !(ADMIN_RELEASE_SERVICE_IDS as readonly string[]).includes(serviceId),
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
    if (releaseDigest(coreServices.canonicalReleaseManifest(manifest)) !== transaction.digest) {
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
      if (!existsSync(repositoryPaths.composePath)) return false;
      const composeArgs = stackArgs();
      const images: Record<string, string> = {
        "app-api": manifest.images.api,
        "app-web": manifest.images.web,
        "data-manager": manifest.images["data-manager"],
        "transitous-runner": manifest.images["transitous-runner"],
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
    await runFixedCli(["services", "update", "--no-deps", ...transaction.serviceIds], context);
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
    if (releaseDigest(coreServices.canonicalReleaseManifest(manifest)) !== transaction.digest) {
      throw new Error("Release authority rejected");
    }
    if (!transaction.phase.startsWith("rollback_") && transaction.serviceIds.length > 1) {
      await requireCurrentAgent(manifest, context);
    }
    if (transaction.phase === "prepared") {
      coreServices.writeReleaseComposeArtifacts(manifest, infraDir, { uid });
      transaction = { ...transaction, phase: "overlay_written" };
      await writeTransaction(transaction);
    }
    if (transaction.phase === "overlay_written") {
      coreServices.writeReleaseComposeArtifacts(manifest, infraDir, { uid });
      await runFixedCli(["services", "update", "--no-deps", ...transaction.serviceIds], context);
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
  const reconcileHandoff = () => {
    const silent = { signal: AbortSignal.timeout(60_000), emitLog: () => undefined };
    return reconcileAgentHandoff({
      rootDir,
      runDocker,
      runningRelease: async (record) => {
        const containerId = await agentContainerId(silent);
        return (
          containerId !== undefined &&
          (await agentMatchesRelease(
            containerId,
            agentPins(loadManifest(record.releaseId)),
            silent,
          ))
        );
      },
      restoreOverlay,
      withStoreLock,
    });
  };
  let initialization: Promise<void> | undefined;
  const initialize = (): Promise<void> => {
    initialization ??= (async () => {
      // The releases of earlier agents come first: everything below reads the
      // store and the overlay. Once done, this is a no-op.
      const migration = await coreServices.migrateLegacyReleaseState(infraDir, {
        uid,
        lockHooks: releaseStoreLockHooks,
      });
      if (migration) runtimeOptions.onLegacyReleaseMigration?.(migration);
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
      // A handoff that cannot be reconciled now must not keep the agent from
      // starting; release operations reconcile again before they proceed.
      await reconcileHandoff().catch(() => undefined);
    })();
    return initialization;
  };
  return {
    initialize,
    validateCandidate,
    resolve: async (context) => {
      await initialize();
      manifestNames();
      const selection = coreServices.releaseSelection();
      if (selection.kind === "local") throw new coreServices.ReleaseChannelDisabledError();
      const image = selection.manifestImage;
      const pulled = await runDocker(["pull", image], context);
      const ociDigest = coreServices.releaseDigestFromPull(pulled);
      const imageId = (
        await runDocker(
          [
            "image",
            "inspect",
            "--format",
            "{{.Id}}",
            `${selection.manifestRepository}@${ociDigest}`,
          ],
          context,
        )
      ).trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(imageId))
        throw new Error("Invalid resolved manifest image ID");
      const containerId = (await runDocker(["create", imageId, "true"], context)).trim();
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
        const manifest = coreServices.parseReleaseManifest(raw, selection.imagePrefix);
        coreServices.validateResolvedSelection(selection, manifest, ociDigest);
        const canonical = coreServices.canonicalReleaseManifest(manifest);
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
          immutableWrite(destination, canonical, uid);
          const receipts = selectionReceipts();
          receipts[manifest.release] = {
            configuration: configurationIdentity(),
            ociDigest,
            digest: releaseDigest(canonical),
          };
          atomicWrite(paths.selections, JSON.stringify(receipts));
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
      const names = [
        "api",
        "web",
        "data-manager",
        "ops-agent",
        "privacy-backup",
        "transitous-runner",
        "transitous-tools",
      ] as const;
      for (const [index, name] of names.entries()) {
        context.emitLog("stdout", `Downloading ${name} image (${index + 1}/${names.length})`);
        await runDocker(["pull", manifest.images[name]], context);
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
      const composeArgs = stackArgs();
      // Path existence alone is not readiness: a directory, an unreadable file,
      // or an unparseable document would all report ready and then fail every
      // later maintenance action. Validate through the Compose boundary itself.
      let composeReady = isRegularComposeFile(repositoryPaths.composePath);
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
        "ops-agent": manifest?.images["ops-agent"],
        "transitous-runner": manifest?.images["transitous-runner"],
      } as const;
      const services: OpsResultFor<"system.inspect">["services"] = [];
      for (const serviceId of INSPECT_RELEASE_SERVICE_IDS) {
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
        const pin =
          pinnedImage && runningImageId
            ? await observePinnedImage(runningImageId, pinnedImage, context)
            : {};
        const localImageId =
          pin.localImageId ??
          (pinnedImage && !runningImageId
            ? await inspectImageId(
                ["image", "inspect", "--format", "{{.Id}}", pinnedImage],
                context,
              )
            : undefined);
        const helper =
          serviceId === "ops-agent" && containerId
            ? await inspectAgentHelper(containerId, context)
            : undefined;
        const state =
          !dockerReachable || !composeReady || !pinnedImage || !observed
            ? "unknown"
            : !containerId
              ? "not_running"
              : pin.matches === undefined || (serviceId === "ops-agent" && !helper)
                ? "unknown"
                : pin.matches &&
                    (serviceId !== "ops-agent" || helper === manifest?.images["privacy-backup"])
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
      // The agent cannot replace the container executing this transaction. A
      // complete admin apply requires its own image and helper to match already:
      // `updateAgent` replaces the agent first, through a separate helper.
      await reconcileHandoff();
      // Claiming the transaction is a read-then-write across processes. Without
      // the lock two agents can both observe no active transaction and both
      // write `transaction.json`, so the loser's rollback state is lost.
      const claimLock = await acquireReleaseStoreLock(directory, releaseStoreLockHooks);
      let manifest: ReturnType<typeof loadManifest>;
      let transaction: ReleaseTransaction;
      try {
        if (readTransaction()) throw new Error("Release transaction already active");
        const handoff = readAgentHandoff(rootDir);
        if (handoff && !isTerminalHandoff(handoff.phase)) {
          throw new Error("Operations agent replacement is still in progress");
        }
        manifest = loadManifest(releaseId);
        if (serviceIds.length > 1) await requireCurrentAgent(manifest, context);
        // A handoff for this release already rewrote the overlay to replace the
        // agent. The application services' rollback target is the overlay from
        // before that handoff, or a failed update would "restore" the new images.
        const afterHandoff =
          handoff?.phase === "applied" && handoff.releaseId === releaseId && !handoff.consumed
            ? handoff
            : undefined;
        const previousOverlay = !afterHandoff
          ? readOverlay()
          : afterHandoff.importedFromLegacy
            ? releaseStateOverlay()
            : afterHandoff.previousOverlay;
        const previousState = existsSync(paths.state)
          ? strictReadFile(paths.state, MAX_RELEASE_STATE_BYTES, { owner: uid })
          : null;
        transaction = {
          version: 1,
          phase: "prepared",
          releaseId,
          digest: releaseDigest(coreServices.canonicalReleaseManifest(manifest)),
          serviceIds: [...serviceIds],
          ...(updateJobId ? { updateJobId } : {}),
          previousOverlay,
          previousState,
        };
        await writeTransaction(transaction);
        if (afterHandoff) {
          writeAgentHandoff(rootDir, {
            ...afterHandoff,
            consumed: true,
            updatedAt: new Date().toISOString(),
          });
        }
      } finally {
        claimLock.release();
      }
      coreServices.writeReleaseComposeArtifacts(manifest, infraDir, { uid });
      transaction = { ...transaction, phase: "overlay_written" };
      await writeTransaction(transaction);
      try {
        await runFixedCli(["services", "update", "--no-deps", ...serviceIds], context);
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
    updateAgent: async (request, context) => {
      await initialize();
      await reconcileHandoff();
      await validateCandidate(request.releaseId, request.expectedDigest);
      const manifest = loadManifest(request.releaseId);
      const silent = { signal: context.signal, emitLog: () => undefined };
      const existing = readAgentHandoff(rootDir);
      if (existing?.handoffId === request.handoffId) {
        return { handoffId: request.handoffId, replaced: true };
      }
      const containerId = await agentContainerId(silent);
      if (!containerId) throw new Error("Operations agent container is unavailable");
      if (await agentMatchesRelease(containerId, agentPins(manifest), silent)) {
        return { handoffId: request.handoffId, replaced: false };
      }
      // Recreating the agent ends every operation it is running.
      if (request.otherActiveOperations > 0) throw new OpsAgentBusyError();
      const timestamp = new Date().toISOString();
      const record = await withStoreLock(() => {
        if (readTransaction()) throw new Error("Release transaction already active");
        const current = readAgentHandoff(rootDir);
        if (current && !isTerminalHandoff(current.phase)) {
          throw new Error("Operations agent replacement is already in progress");
        }
        const launched = {
          version: 1 as const,
          handoffId: request.handoffId,
          releaseId: request.releaseId,
          digest: request.expectedDigest,
          phase: "launched" as const,
          previousOverlay: readOverlay(),
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        writeAgentHandoff(rootDir, launched);
        return launched;
      });
      try {
        const facts = await inspectAgentContainer(runDocker, containerId, rootDir, context.signal);
        await runDocker(agentHandoffRunArgs(facts, rootDir, request.handoffId), silent);
      } catch (error) {
        advanceAgentHandoff(rootDir, record, {
          phase: "failed",
          reason: "The replacement helper could not start; nothing was changed",
        });
        throw error;
      }
      context.emitLog("stdout", "Replacing the operations agent; it restarts shortly");
      return { handoffId: request.handoffId, replaced: true };
    },
    inspectAgentHandoff: async (handoffId) => {
      let record = readAgentHandoff(rootDir);
      // A helper from an earlier release records its outcome where that
      // release kept its state, which this agent no longer reads. Once that
      // helper has exited, settle the handoff here as a restart would.
      if (
        record?.handoffId === handoffId &&
        record.importedFromLegacy === true &&
        !isTerminalHandoff(record.phase)
      ) {
        await reconcileHandoff().catch(() => undefined);
        record = readAgentHandoff(rootDir);
        if (record && isTerminalHandoff(record.phase)) {
          await runtimeOptions.afterHandoffSettled?.().catch(() => undefined);
        }
      }
      if (record?.handoffId !== handoffId) return { handoffId, phase: "none" };
      return {
        handoffId,
        phase: record.phase,
        ...(record.reason === undefined ? {} : { reason: record.reason }),
      };
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

/**
 * The fixed CLI the agent runs. In the image both are runtime bundles and
 * `cli.mjs` sits next to the agent's entry; in development the agent runs from
 * `src/` and the CLI runs from source under tsx.
 */
export function createDefaultFixedCli(
  _rootDir: string,
  entry: string = process.argv[1] ?? "",
): FixedCliRunner {
  const entryDirectory = dirname(entry);
  const bundled = join(entryDirectory, "cli.mjs");
  const runtimeRoot = join(entryDirectory, "..", "..", "..");
  const [executable, ...prefix] = existsSync(bundled)
    ? [process.execPath, bundled]
    : [
        join(runtimeRoot, "packages", "cli", "node_modules", ".bin", "tsx"),
        "--tsconfig",
        join(runtimeRoot, "packages", "cli", "tsconfig.json"),
        join(runtimeRoot, "packages", "cli", "src", "index.ts"),
      ];
  return async (args, options) => {
    const result = await runContainedProcess(executable as string, [...prefix, ...args], {
      signal: options.signal,
      timeout: MAX_CLI_DURATION_MS,
      maxBuffer: MAX_CLI_OUTPUT_BYTES,
    });
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
  // While an earlier release's selection did not come over, resolving or
  // applying a release would upgrade to whatever is newest: the operator
  // selects one on the host instead, which the panel's message says.
  const assertReleaseSelectable = (context: { emitLog: FixedCliOptions["emitLog"] }) => {
    const held = coreServices.releaseSelectionHold(infraDirectory(options.rootDir));
    if (!held) return;
    context.emitLog("stderr", held);
    throw new OpsHostUpdateRequiredError();
  };
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
    const lock = await acquireBackupStoreLock(options.rootDir);
    try {
      await runFixedCli(["backup", "create", "--name", operation.backupId], {
        signal: context.signal,
        emitLog: context.emitLog,
      });
    } finally {
      lock.release();
    }
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
  runtime["data.notablePlacesBuild"] = async (_operation, context) => {
    await runFixedCli(["data", "notable-places", "build"], {
      signal: context.signal,
      emitLog: context.emitLog,
    });
    return { completed: true };
  };
  runtime["system.diagnostics"] = async (_operation, context) => {
    await runFixedCli(["check"], {
      signal: context.signal,
      emitLog: context.emitLog,
    });
    return { ok: true, checks: [] };
  };
  runtime["system.inspect"] = async (_operation, context) => releaseEffects.inspectSystem(context);
  runtime["release.resolve"] = async (_operation, context) => {
    assertReleaseSelectable(context);
    return { releaseId: await releaseEffects.resolve(context) };
  };
  runtime["release.pull"] = async (operation, context) => {
    await releaseEffects.pull(operation.releaseId, context);
    return { releaseId: operation.releaseId };
  };
  runtime["release.inspect"] = async () => releaseEffects.inspect();
  runtime["release.apply"] = async (operation, context) => {
    assertReleaseSelectable(context);
    await releaseEffects.apply(operation.releaseId, [...ADMIN_RELEASE_SERVICE_IDS], context);
    return { releaseId: operation.releaseId };
  };
  runtime["appApi.replace"] = async (operation, context) => {
    assertReleaseSelectable(context);
    await releaseEffects.apply(operation.releaseId, ["app-api"], context, operation.updateJobId);
    return { updateJobId: operation.updateJobId, replaced: true };
  };
  runtime["appApi.runtime.inspect"] = async () => releaseEffects.runtimeInspect?.() ?? {};
  runtime["agent.update"] = async (operation, context) => {
    if (!releaseEffects.updateAgent) throw new Error("Agent replacement unavailable");
    assertReleaseSelectable(context);
    return releaseEffects.updateAgent(
      {
        releaseId: operation.releaseId,
        expectedDigest: operation.expectedDigest,
        handoffId: operation.handoffId,
        otherActiveOperations: context.otherActiveOperations?.() ?? 0,
      },
      context,
    );
  };
  runtime["agent.handoff.inspect"] = async (operation) => {
    if (!releaseEffects.inspectAgentHandoff) throw new Error("Agent replacement unavailable");
    return releaseEffects.inspectAgentHandoff(operation.handoffId);
  };
  runtime["system.update"] = async (operation, context) => {
    if (!releaseEffects.validateCandidate)
      throw new Error("Checked release validation unavailable");
    assertReleaseSelectable(context);
    await releaseEffects.validateCandidate(operation.releaseId, operation.expectedDigest);
    if (operation.createBackup && operation.backupId) {
      await runFixedCli(["backup", "create", "--name", operation.backupId], context);
    }
    await releaseEffects.pull(operation.releaseId, context);
    await releaseEffects.apply(operation.releaseId, [...ADMIN_RELEASE_SERVICE_IDS], context);
    return { releaseId: operation.releaseId };
  };
  return runtime;
}
