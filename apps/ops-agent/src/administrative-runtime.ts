import { loadConfiguredResourceAuthority } from "./configured-resource-authority";
import { installDataWorkflowRuntime } from "./data-workflow-runtime";

export {
  type ConfiguredResourceAuthority,
  loadConfiguredResourceAuthority,
} from "./configured-resource-authority";

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
  bindControlChildPhase,
  closeControlInstallation,
  consumeControlChildDispatch,
  fixedCliArguments as coreFixedCliArguments,
  isFixedSingleDataCommand,
  issueControlChildPhase,
  openFixedChildInstallation,
  prepareFixedControlChild,
  readFixedCliSpawnIntent,
  readFixedSingleDataPlan,
  retainFixedCliSpawnIntent,
  verifyControlEffectSettlement,
} from "@openmapx/core/build-artifacts";
import {
  compareServiceBuildOrder,
  createServiceBatchResult,
  type ExecutionRef,
  executionRefSchema,
  OPS_MAX_BACKUP_ID_LENGTH,
  OPS_MAX_BACKUP_INVENTORY_ENTRIES,
  OPS_PUBLIC_ERROR_MESSAGES,
  type OpsOperationKind,
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
import { runContainedProcess, runContainedStreamingProcess } from "./docker-runtime";
import { strictReadFile } from "./durable-files";
import { safeProcessDiagnostic } from "./process-output";
import { createImageInspection } from "./release-images";
import {
  OpsAgentBusyError,
  type OpsExecutionContext,
  OpsExecutionFailure,
  OpsHostUpdateRequiredError,
  OpsNotWiredError,
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
const MAX_RELEASE_MANIFEST_BYTES = 32 * 1024;
const MAX_RELEASE_STATE_BYTES = 4 * 1024;
const MAX_RELEASE_TRANSACTION_BYTES = 128 * 1024;
const MAX_RELEASE_STORE_ENTRIES = 64;
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

export interface FixedCliOptions {
  operationKind?: OpsOperationKind;
  execution?: ExecutionRef;
  controlAssertion?: string;
  parentAssertion?: string;
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
  let contents: string;
  try {
    contents = readDescriptorAnchoredUtf8(
      rootDir,
      ["infra", "docker", "backups", backupId, "manifest.json"],
      { minimumBytes: 1, maximumBytes: MAX_BACKUP_MANIFEST_BYTES },
    );
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
              rootDir,
              ["infra", "docker", "backups", entry.name, volume.file],
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
      const measured = hashDescriptorAnchoredFile(
        rootDir,
        ["infra", "docker", "backups", backupId, volume.file],
        {
          maximumBytes: Number.MAX_SAFE_INTEGER,
          expectedBytes: volume.sizeBytes,
          expectedSha256: volume.sha256,
        },
      );
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
    emitLog(stream, safeProcessDiagnostic(line));
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

function releaseDigest(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
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

function releaseStoreBindings(rootDir: string, hooks: ReleaseStoreLockHooks = {}) {
  const directory = releaseDirectory(rootDir);
  const infraDir = join(rootDir, "infra", "docker");
  const repositoryPaths: coreServices.StackPaths = {
    infraDir,
    composePath: coreServices.currentConfigurationFile(
      infraDir,
      coreServices.GENERATED_COMPOSE_FILE,
    ),
    composeReleasePath: join(infraDir, "docker-compose.release.yml"),
  };
  const overlay = repositoryPaths.composeReleasePath;
  return {
    repositoryPaths,
    stackArgs: () => coreServices.stackComposeArgs(repositoryPaths, isRegularComposeFile),
    readOverlay: () =>
      existsSync(overlay) ? strictReadFile(overlay, MAX_RELEASE_MANIFEST_BYTES) : null,
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
export function createAgentHandoffBindings(rootDir: string) {
  const bindings = releaseStoreBindings(rootDir);
  const loadStored = (releaseId: string, digest: string) => {
    const raw = strictReadFile(releaseManifestPath(rootDir, releaseId), MAX_RELEASE_MANIFEST_BYTES);
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
    // Task08.3 installs the guarded helper. A parent observation cannot
    // authorize this detached process or its rollback after the parent exits.
    assertAvailable: (): never => {
      throw new OpsNotWiredError();
    },
    restoreOverlay: (_previousOverlay: string | null): never => {
      throw new OpsNotWiredError();
    },
    withStoreLock: bindings.withStoreLock,
    releasePins: (releaseId: string, digest: string) => {
      const manifest = loadStored(releaseId, digest);
      return {
        agentImage: manifest.images["ops-agent"],
        helperImage: manifest.images["privacy-backup"],
      };
    },
    writeOverlay: (_releaseId: string, _digest: string): never => {
      throw new OpsNotWiredError();
    },
  };
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
    selections: join(directory, "selections.json"),
  };
  const { repositoryPaths, stackArgs, restoreOverlay, withStoreLock, readOverlay } =
    releaseStoreBindings(rootDir, releaseStoreLockHooks);
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
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error("Release store contains an unsafe entry");
        }
        continue;
      }
      if (["current.json", "latest.json", "transaction.json", "selections.json"].includes(name)) {
        const stat = lstatSync(join(directory, name));
        const maximum =
          name === "transaction.json"
            ? MAX_RELEASE_TRANSACTION_BYTES
            : name === "selections.json"
              ? 32 * 1024
              : MAX_RELEASE_STATE_BYTES;
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
        timeout: remainingCliTime(context),
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
  const configurationIdentity = () =>
    releaseDigest(JSON.stringify(coreServices.releaseSelection()));
  const selectionReceipts = (): Record<
    string,
    { configuration: string; ociDigest: string; digest: string }
  > => {
    if (!existsSync(paths.selections)) return {};
    const value = JSON.parse(strictReadFile(paths.selections, 32 * 1024));
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length > MAX_RELEASE_STORE_ENTRIES
    )
      throw new Error("Invalid release selection receipts");
    for (const [id, receipt] of Object.entries(value) as [string, Record<string, unknown>][])
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) ||
        !receipt ||
        Object.keys(receipt).sort().join() !== "configuration,digest,ociDigest" ||
        !/^[a-f0-9]{64}$/.test(String(receipt.configuration)) ||
        !/^[a-f0-9]{64}$/.test(String(receipt.digest)) ||
        !/^sha256:[a-f0-9]{64}$/.test(String(receipt.ociDigest))
      )
        throw new Error("Invalid release selection receipt");
    return value;
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
    execution?: ExecutionRef;
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
    if (value.execution !== undefined) executionRefSchema.parse(value.execution);
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
    if (!transaction.execution) throw new OpsExecutionFailure("recovery_required", {});
    context = { ...context, execution: transaction.execution };
    remainingCliTime(context);
    await writeTransaction({ ...transaction, phase: "rollback_overlay" });
    remainingCliTime(context);
    if (transaction.previousOverlay === null) durableUnlink(paths.overlay);
    else atomicWrite(paths.overlay, transaction.previousOverlay);
    await writeTransaction({ ...transaction, phase: "rollback_services" });
    remainingCliTime(context);
    await runFixedCli(["services", "update", "--no-deps", ...transaction.serviceIds], context);
    remainingCliTime(context);
    if (transaction.previousState === null) durableUnlink(paths.state);
    else atomicWrite(paths.state, transaction.previousState);
    durableUnlink(paths.transaction);
  };
  const completeForward = async (
    transaction: ReleaseTransaction,
    context: FixedCliOptions,
  ): Promise<void> => {
    if (!transaction.execution) throw new OpsExecutionFailure("recovery_required", {});
    context = { ...context, execution: transaction.execution };
    remainingCliTime(context);
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
      remainingCliTime(context);
      coreServices.writeReleaseComposeArtifacts(manifest, paths.overlay);
      transaction = { ...transaction, phase: "overlay_written" };
      await writeTransaction(transaction);
    }
    if (transaction.phase === "overlay_written") {
      remainingCliTime(context);
      coreServices.writeReleaseComposeArtifacts(manifest, paths.overlay);
      remainingCliTime(context);
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
      remainingCliTime(context);
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
      remainingCliTime(context);
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
          immutableWrite(destination, canonical);
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
        if (runtimeOptions.runDocker) await runDocker(["pull", manifest.images[name]], context);
        else
          await runContainedStreamingProcess("docker", ["pull", manifest.images[name]], {
            signal: context.signal,
            timeout: remainingCliTime(context),
            onLine: context.emitLog,
            redact: safeProcessDiagnostic,
          });
      }
    },
    inspect: async () => {
      return inspectRelease();
    },
    inspectSystem: async (context) => {
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
        const previousOverlay = afterHandoff ? afterHandoff.previousOverlay : readOverlay();
        const previousState = existsSync(paths.state)
          ? strictReadFile(paths.state, MAX_RELEASE_STATE_BYTES)
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
          ...(context.execution ? { execution: context.execution } : {}),
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
      coreServices.writeReleaseComposeArtifacts(manifest, paths.overlay);
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
      const silent = { ...context, emitLog: () => undefined };
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
      const record = readAgentHandoff(rootDir);
      if (record?.handoffId !== handoffId) return { handoffId, phase: "none" };
      return {
        handoffId,
        phase: record.phase,
        ...(record.reason === undefined ? {} : { reason: record.reason }),
      };
    },
    runtimeInspect: async () => {
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
function remainingCliTime(options: FixedCliOptions): number {
  if (options.signal.aborted) throw new OpsExecutionFailure("runtime", {});
  if (!options.execution) {
    if (options.operationKind) throw new Error("Managed execution context is required");
    return MAX_CLI_DURATION_MS;
  }
  const execution = executionRefSchema.parse(options.execution);
  const remaining = execution.deadlineAt - Date.now();
  if (remaining <= 0) throw new OpsExecutionFailure("timeout", {});
  return remaining;
}

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
    const timeout = remainingCliTime(options);
    const env = { ...process.env };
    for (const key of [
      "OPENMAPX_CONTROL_EXECUTION",
      "OPENMAPX_CONTROL_DELEGATION",
      "OPENMAPX_PARENT_EXECUTION",
    ])
      delete env[key];
    if (options.execution) {
      const encoded = JSON.stringify(executionRefSchema.parse(options.execution));
      if (Buffer.byteLength(encoded) > 2048) throw new Error("Execution context exceeds budget");
      env.OPENMAPX_CONTROL_EXECUTION = encoded;
      if (options.controlAssertion || options.parentAssertion) {
        if (options.controlAssertion && options.parentAssertion)
          throw Error("Ambiguous CLI authority");
        const assertion = (options.controlAssertion ?? options.parentAssertion)!;
        const installation = openFixedChildInstallation({
          infraDir: join(_rootDir, "infra/docker"),
          assertion,
          container: existsSync("/run/secrets/openmapx-control-verifiers"),
        });
        try {
          readFixedCliSpawnIntent(installation, options.execution, args);
        } finally {
          closeControlInstallation(installation);
        }
        if (options.controlAssertion) env.OPENMAPX_CONTROL_DELEGATION = assertion;
        else env.OPENMAPX_PARENT_EXECUTION = assertion;
      }
    } else if (options.controlAssertion || options.parentAssertion)
      throw new Error("Execution context is required");
    await runContainedStreamingProcess(executable as string, [...prefix, ...args], {
      env,
      signal: options.signal,
      timeout,
      onLine: options.emitLog,
      redact: safeProcessDiagnostic,
    });
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
      .sort((left, right) => compareServiceBuildOrder(left.serviceId, right.serviceId));
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
    const plan = await loadBuildable();
    const serviceIds = plan.map((service) => service.serviceId);
    const completedServiceIds: string[] = [];
    const failedServiceIds: string[] = [];
    const batch = (skipped: string[]) =>
      createServiceBatchResult(serviceIds, completedServiceIds, failedServiceIds, skipped);
    if (plan.length === 0) throw new OpsExecutionFailure("runtime", { serviceBatch: batch([]) });
    for (const [index, service] of plan.entries()) {
      let attempted = false;
      let stop: OpsExecutionFailure | undefined;
      try {
        context.signal.throwIfAborted();
        attempted = true;
        await runFixedCli(buildArgs(service.serviceId, operation.regionId), context);
        completedServiceIds.push(service.serviceId);
      } catch (error) {
        if (
          context.signal.aborted ||
          (error instanceof Error && error.name === "AbortError") ||
          (error instanceof OpsExecutionFailure && error.errorClass !== "runtime")
        ) {
          stop = new OpsExecutionFailure(
            error instanceof OpsExecutionFailure
              ? error.errorClass
              : Date.now() >= context.execution.deadlineAt
                ? "timeout"
                : "recovery_required",
            {
              ...(error instanceof OpsExecutionFailure ? error.failureResult : {}),
              serviceBatch: batch(serviceIds.slice(index + (attempted ? 1 : 0))),
            },
          );
        } else {
          failedServiceIds.push(service.serviceId);
          if (operation.failFast)
            stop = new OpsExecutionFailure("runtime", {
              ...(error instanceof OpsExecutionFailure ? error.failureResult : {}),
              serviceBatch: batch(serviceIds.slice(index + 1)),
            });
        }
      }
      const serviceBatch = stop?.failureResult.serviceBatch ?? batch(serviceIds.slice(index + 1));
      try {
        await context.checkpointServiceBatch?.(serviceBatch);
      } catch {
        throw new OpsExecutionFailure("recovery_required", { serviceBatch });
      }
      if (stop) throw stop;
    }
    if (failedServiceIds.length > 0)
      throw new OpsExecutionFailure("runtime", { serviceBatch: batch([]) });
    return { completedServiceIds, failedServiceIds };
  };
  runtime["backup.list"] = async () => inspectBackupInventory(options.rootDir);
  runtime["backup.create"] = async (operation, context) => {
    const lock = await acquireBackupStoreLock(options.rootDir);
    try {
      await runFixedCli(["backup", "create", "--name", operation.backupId], {
        ...context,
        operationKind: context.claim.operation.kind,
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
        { ...context, operationKind: context.claim.operation.kind },
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
        ...context,
        operationKind: context.claim.operation.kind,
      });
    } finally {
      lock.release();
    }
    return { backupId: operation.backupId };
  };
  runtime["data.inspect"] = async () => inspectDataInventory(options.rootDir);
  async function runMatchingDataCommand(
    operation: import("@openmapx/core/ops").OpsOperation,
    context: import("./runtime").OpsExecutionContext,
  ): Promise<void> {
    if (!isFixedSingleDataCommand(operation.kind) || !context.controlAuthority)
      throw new OpsHostUpdateRequiredError();
    const plan = readFixedSingleDataPlan(context.controlAuthority),
      bound = await bindControlChildPhase(context.controlAuthority, plan.rootReservation);
    const publicKey = prepareFixedControlChild(context.controlAuthority, plan.delegationId);
    retainFixedCliSpawnIntent(context.controlAuthority, {
      delegationId: plan.delegationId,
      execution: bound.execution,
      operation,
      args: coreFixedCliArguments(operation),
      reservations: plan.cliReservations,
    });
    const issued = await issueControlChildPhase(context.controlAuthority, {
      phase: "data-workflow",
      ordinal: 0,
      childPublicKey: publicKey,
    });
    consumeControlChildDispatch(issued.dispatchTicket);
    await runFixedCli(coreFixedCliArguments(operation), {
      ...context,
      execution: bound.execution,
      parentAssertion: issued.assertion,
      operationKind: operation.kind,
    });
    const child = openFixedChildInstallation({
      infraDir: join(options.rootDir, "infra/docker"),
      assertion: issued.assertion,
      container: existsSync("/run/secrets/openmapx-control-verifiers"),
    });
    try {
      verifyControlEffectSettlement(child, bound.execution);
    } finally {
      closeControlInstallation(child);
    }
  }
  runtime["data.downloadOsm"] = async (operation, context) => {
    await runMatchingDataCommand(operation, context);
    return { completed: true, ...(operation.regionId ? { resourceId: operation.regionId } : {}) };
  };
  runtime["data.downloadFonts"] = async (operation, context) => {
    await runMatchingDataCommand(operation, context);
    return { completed: true };
  };
  // Full Update owns its target-free data phase and one guarded finalization phase.
  installDataWorkflowRuntime(runtime, { rootDir: options.rootDir, runFixedCli });
  runtime["data.convertOverpass"] = async (operation, context) => {
    await runMatchingDataCommand(operation, context);
    return { completed: true, ...(operation.regionId ? { resourceId: operation.regionId } : {}) };
  };
  runtime["data.link"] = async (_operation, context) => {
    await runFixedCli(["data", "link"], {
      ...context,
      operationKind: context.claim.operation.kind,
    });
    return { completed: true };
  };
  runtime["data.clean"] = async (operation, context) => {
    await runFixedCli(["data", "clean", operation.dataTypeId], {
      ...context,
      operationKind: context.claim.operation.kind,
    });
    return { completed: true, resourceId: operation.dataTypeId };
  };
  runtime["data.generateApiKeys"] = async (_operation, context) => {
    await runFixedCli(["data", "generate-api-keys"], {
      ...context,
      operationKind: context.claim.operation.kind,
    });
    return { completed: true };
  };
  runtime["data.overtureSync"] = async (operation, context) => {
    await runMatchingDataCommand(operation, context);
    return { completed: true, resourceId: operation.regionId };
  };
  runtime["data.overtureConflate"] = async (operation, context) => {
    await runMatchingDataCommand(operation, context);
    return { completed: true, resourceId: operation.regionId };
  };
  runtime["data.searchIndexBuild"] = async (operation, context) => {
    await runMatchingDataCommand(operation, context);
    return { completed: true, resourceId: operation.regionId };
  };
  runtime["data.notablePlacesBuild"] = async (operation, context) => {
    await runMatchingDataCommand(operation, context);
    return { completed: true };
  };
  runtime["system.diagnostics"] = async (_operation, context) => {
    await runFixedCli(["check"], {
      ...context,
      operationKind: context.claim.operation.kind,
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
    await releaseEffects.apply(operation.releaseId, [...ADMIN_RELEASE_SERVICE_IDS], context);
    return { releaseId: operation.releaseId };
  };
  runtime["appApi.replace"] = async (operation, context) => {
    await releaseEffects.apply(operation.releaseId, ["app-api"], context, operation.updateJobId);
    return { updateJobId: operation.updateJobId, replaced: true };
  };
  runtime["appApi.runtime.inspect"] = async () => releaseEffects.runtimeInspect?.() ?? {};
  runtime["agent.update"] = async (operation, context) => {
    if (!releaseEffects.updateAgent) throw new Error("Agent replacement unavailable");
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
