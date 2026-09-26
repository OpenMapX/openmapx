import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  createReadStream,
  createWriteStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import {
  erasureVerificationIdentifiers,
  TERMINAL_PRIVACY_REQUEST_STATES,
} from "@openmapx/core/erasure-cleanup";
import {
  assertErasureJournalKey,
  isErasedSubject,
  readErasureJournal,
  readErasureJournalKeyFile,
} from "@openmapx/core/erasure-journal";
import { services as coreServices } from "@openmapx/core/server";
import { PLATFORM_VERSION } from "@openmapx/integration-framework";
import type { Command } from "commander";
import { execa } from "execa";
import kleur from "kleur";
import { log, table } from "../lib/output";
import { repoPaths } from "../lib/paths";
import { applyServiceSelection } from "../lib/service-selection";

const { ServiceRegistry, isSafePostgresIdentifier } = coreServices;

// ─── Public types ───────────────────────────────────────────────────────────

export type BackupVolumeMode = "tar" | "pg_dump";

export interface BackupVolumeEntry {
  name: string;
  /**
   * Resolved on-host docker volume name at backup time (e.g.
   * `openmapx_openmapx-pgdata` for declared name `openmapx-pgdata`). Persisted
   * so restore works even if the compose project name changes between
   * backup and restore (different cwd, COMPOSE_PROJECT_NAME override, host
   * migration). tar-mode entries only.
   */
  resolvedName?: string;
  mode: BackupVolumeMode;
  file: string;
  sizeBytes: number;
  sha256: string;
  /**
   * Postgres credentials captured from the producer service's manifest at
   * backup time (`pg_dump`-mode entries only). Persisted so restore targets
   * the same database/user even if `services/postgis/service.json` changes
   * between backup and restore.
   */
  postgresUser?: string;
  postgresDb?: string;
}

export interface BackupServiceEntry {
  id: string;
  version: string;
  volumes: BackupVolumeEntry[];
}

export interface BackupManifest {
  formatVersion: 2;
  name: string;
  createdAt: string;
  openmapxVersion: string;
  services: BackupServiceEntry[];
  privacySourceProvenance?: {
    managedDawarich?: {
      version: "1.15.2";
      image: "freikin/dawarich";
      imageDigest: string;
      upstreamCommit: string;
      schemaContract: "dawarich-1.15.2";
    };
  };
}

// ─── Validation helpers (pure / unit-testable) ─────────────────────────────

// Leading char must be alphanumeric: this rejects "." / ".." (which, joined into
// the backups directory, resolve to the backups root or its parent) and
// leading-dash names. ISO-timestamp default names start with a digit, so they
// remain valid.
const NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

// Docker volume names, per Docker's grammar. This has no "/", so a manifest
// cannot turn `docker run -v <name>:/target` into an arbitrary host bind mount.
const VOLUME_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

// Backup archives are bare siblings of manifest.json, never paths or traversal.
const BACKUP_FILE_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

// Compose service ids use the same lowercase slug shape as service manifests.
const SERVICE_ID_REGEX = /^[a-z0-9][a-z0-9-]*$/;

export function isValidBackupName(name: string): boolean {
  return typeof name === "string" && name.length > 0 && NAME_REGEX.test(name);
}

export function assertValidBackupName(name: string): void {
  if (!isValidBackupName(name)) {
    throw new Error(`Invalid backup name "${name}" — must match ${NAME_REGEX.toString()}`);
  }
}

export function assertValidVolumeEntry(entry: BackupVolumeEntry, context: string): void {
  if (!entry || typeof entry !== "object") {
    throw new Error(`Invalid volume entry in ${context}`);
  }
  if (typeof entry.name !== "string" || !VOLUME_NAME_REGEX.test(entry.name)) {
    throw new Error(`Invalid volume name in ${context}`);
  }
  if (entry.mode !== "tar" && entry.mode !== "pg_dump") {
    throw new Error(`Invalid volume mode in ${context}`);
  }
  if (typeof entry.file !== "string" || !BACKUP_FILE_REGEX.test(entry.file)) {
    throw new Error(`Invalid backup file in ${context}`);
  }
  if (
    typeof entry.sizeBytes !== "number" ||
    !Number.isFinite(entry.sizeBytes) ||
    entry.sizeBytes < 0
  ) {
    throw new Error(`Invalid backup size in ${context}`);
  }
  if (
    entry.sha256 !== undefined &&
    (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256))
  ) {
    throw new Error(`Invalid backup digest in ${context}`);
  }
  if (
    entry.resolvedName !== undefined &&
    (typeof entry.resolvedName !== "string" || !VOLUME_NAME_REGEX.test(entry.resolvedName))
  ) {
    throw new Error(`Invalid docker volume name in ${context}`);
  }
  if (entry.postgresUser !== undefined && !isSafePostgresIdentifier(entry.postgresUser)) {
    throw new Error(`Invalid postgres user in ${context}`);
  }
  if (entry.postgresDb !== undefined && !isSafePostgresIdentifier(entry.postgresDb)) {
    throw new Error(`Invalid postgres database in ${context}`);
  }
}

/**
 * Resolve a named backup's directory under infra/docker/backups and assert the
 * result stays strictly inside that root. `assertValidBackupName` already rejects
 * traversal-shaped names; this is the shared defense-in-depth backstop (used by
 * create/restore/delete) so a future gap in that guard can neither escape the
 * backups root nor target the root itself.
 */
export function resolveBackupDir(rootDir: string | undefined, name: string): string {
  const backupsRoot = resolve(repoPaths(rootDir).infraDir, "backups");
  const backupDir = resolve(backupsRoot, name);
  if (!backupDir.startsWith(`${backupsRoot}/`)) {
    throw new Error(`Refusing to operate on a backup path outside backups/: ${backupDir}`);
  }
  return backupDir;
}

/** Default backup name = ISO timestamp with `:` replaced by `-`. */
export function defaultBackupName(now: Date = new Date()): string {
  return now
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\.\d{3}/, "");
}

/** Major-version comparison. Returns true if `current` major matches `manifest`. */
export function isCompatiblePlatformVersion(
  manifestVersion: string,
  current: string = PLATFORM_VERSION,
): { compatible: boolean; majorMismatch: boolean; minorMismatch: boolean } {
  const [mMajor, mMinor = 0] = manifestVersion.split(".").map((n) => Number(n));
  const [cMajor, cMinor = 0] = current.split(".").map((n) => Number(n));
  if (Number.isNaN(mMajor) || Number.isNaN(cMajor)) {
    return { compatible: true, majorMismatch: false, minorMismatch: false };
  }
  const majorMismatch = mMajor !== cMajor;
  const minorMismatch = !majorMismatch && mMinor !== cMinor;
  return { compatible: !majorMismatch, majorMismatch, minorMismatch };
}

/**
 * Read and validate an untrusted, portable manifest from disk. Its fields reach
 * docker run volume mounts, database command argv, and filesystem joins, so
 * every field is shape-checked here rather than only at the sinks.
 */
export function readBackupManifest(filePath: string): BackupManifest {
  let manifestStat: ReturnType<typeof lstatSync>;
  try {
    manifestStat = lstatSync(filePath);
  } catch {
    throw new Error(`Backup manifest not found: ${filePath}`);
  }
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.nlink !== 1) {
    throw new Error(`Backup manifest is not a private regular file: ${filePath}`);
  }
  const raw = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<BackupManifest>;
  if (
    !raw ||
    typeof raw.name !== "string" ||
    typeof raw.createdAt !== "string" ||
    typeof raw.openmapxVersion !== "string" ||
    !Array.isArray(raw.services)
  ) {
    throw new Error(`Malformed backup manifest at ${filePath}`);
  }
  if (raw.formatVersion !== 2) {
    throw new Error(`Malformed backup format version in ${filePath}`);
  }
  const managed = raw.privacySourceProvenance?.managedDawarich;
  if (
    managed &&
    (managed.version !== "1.15.2" ||
      managed.image !== "freikin/dawarich" ||
      !/^sha256:[a-f0-9]{64}$/.test(managed.imageDigest) ||
      !/^[a-f0-9]{40}$/.test(managed.upstreamCommit) ||
      managed.schemaContract !== "dawarich-1.15.2")
  )
    throw new Error(`Malformed Dawarich privacy provenance in ${filePath}`);
  if (!isValidBackupName(raw.name)) {
    throw new Error(`Malformed backup identity in ${filePath}`);
  }
  const serviceIds = new Set<string>();
  const files = new Set<string>();
  for (const s of raw.services) {
    if (typeof s.id !== "string" || typeof s.version !== "string" || !Array.isArray(s.volumes)) {
      throw new Error(`Malformed service entry in ${filePath}`);
    }
    if (!SERVICE_ID_REGEX.test(s.id)) {
      throw new Error(`Invalid service id in ${filePath}: ${s.id}`);
    }
    if (serviceIds.has(s.id)) throw new Error(`Duplicate service id in ${filePath}: ${s.id}`);
    serviceIds.add(s.id);
    for (const volume of s.volumes) {
      assertValidVolumeEntry(volume, filePath);
      if (files.has(volume.file)) throw new Error(`Duplicate backup file in ${filePath}`);
      files.add(volume.file);
      if (!volume.sha256) throw new Error(`Missing backup digest in ${filePath}`);
      if (volume.mode === "pg_dump" && (!volume.postgresUser || !volume.postgresDb)) {
        throw new Error(`Missing postgres credentials in ${filePath}`);
      }
      if (volume.mode === "tar" && !volume.resolvedName) {
        throw new Error(`Missing resolved docker volume name in ${filePath}`);
      }
    }
  }
  return raw as BackupManifest;
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath, { flags: "r" });
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Verify a file's size and digest immediately before any restore or privacy extraction reads it. */
export async function verifyBackupVolumeFile(
  volume: BackupVolumeEntry,
  backupDir: string,
): Promise<string> {
  const file = resolve(backupDir, volume.file);
  if (!file.startsWith(`${resolve(backupDir)}/`) || !existsSync(file))
    throw new Error("Backup file is unavailable");
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error("Backup file is not a regular file");
  if (stat.size !== volume.sizeBytes || (await sha256File(file)) !== volume.sha256)
    throw new Error("Backup file digest changed");
  return file;
}

/** Filter a manifest down to a subset of services. Throws if any id is unknown. */
export function filterManifestServices(manifest: BackupManifest, ids: string[]): BackupManifest {
  const known = new Set(manifest.services.map((s) => s.id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw new Error(
      `Backup does not contain service(s): ${missing.join(", ")}. ` +
        `Available: ${[...known].join(", ") || "(none)"}`,
    );
  }
  const wanted = new Set(ids);
  return {
    ...manifest,
    services: manifest.services.filter((s) => wanted.has(s.id)),
  };
}

// ─── Service discovery ─────────────────────────────────────────────────────

export interface BackupableVolume {
  serviceId: string;
  volumeName: string;
  mode: BackupVolumeMode;
}

export interface BackupableService {
  id: string;
  version: string;
  postgresUser?: string;
  postgresDb?: string;
  volumes: BackupableVolume[];
}

interface DiscoverOptions {
  rootDir?: string;
  /** Explicit allow-list of service ids to consider. */
  serviceIds?: string[];
}

export async function discoverBackupableServices(
  opts: DiscoverOptions = {},
): Promise<BackupableService[]> {
  const paths = repoPaths(opts.rootDir);
  const registry = new ServiceRegistry({ rootDir: paths.root });
  await registry.load();
  applyServiceSelection(registry, { rootDir: paths.root });
  const enabled = registry.enabled();
  const wanted = opts.serviceIds ? new Set(opts.serviceIds) : null;

  const out: BackupableService[] = [];
  for (const svc of enabled) {
    if (wanted && !wanted.has(svc.manifest.id)) continue;
    const backupVolumes = (svc.manifest.volumes ?? []).filter((v) => v.backup === true);
    if (backupVolumes.length === 0) continue;
    const env = svc.manifest.container.environment ?? {};
    const missingMode = backupVolumes.find((volume) => volume.backupMode === undefined);
    if (missingMode) {
      throw new Error(
        `Service "${svc.manifest.id}" backup volume "${missingMode.name}" must declare backupMode`,
      );
    }
    const modes = backupVolumes.map((volume) => volume.backupMode as BackupVolumeMode);
    const postgresUser = env.POSTGRES_USER;
    const postgresDb = env.POSTGRES_DB;
    if (
      modes.includes("pg_dump") &&
      (!isSafePostgresIdentifier(postgresUser) || !isSafePostgresIdentifier(postgresDb))
    ) {
      throw new Error(
        `Service "${svc.manifest.id}" declares pg_dump backup data without safe literal POSTGRES_USER and POSTGRES_DB values`,
      );
    }
    out.push({
      id: svc.manifest.id,
      version: svc.manifest.version,
      postgresUser,
      postgresDb,
      volumes: backupVolumes.map((v) => ({
        serviceId: svc.manifest.id,
        volumeName: v.name,
        mode: v.backupMode as BackupVolumeMode,
      })),
    });
  }
  return out;
}

// ─── Docker compose helpers (parameterised by paths/file for testability) ──

interface ComposeContext {
  composeFile: string;
  cwd: string;
}

function ctxFromRepo(rootDir?: string): ComposeContext {
  const paths = repoPaths(rootDir);
  return { composeFile: paths.composeOutPath, cwd: paths.infraDir };
}

async function dockerCompose(ctx: ComposeContext, args: string[]): Promise<string> {
  const result = await execa("docker", ["compose", "-f", ctx.composeFile, ...args], {
    cwd: ctx.cwd,
    reject: false,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `docker compose ${args.join(" ")} failed (exit ${result.exitCode}): ${
        result.stderr || result.stdout
      }`,
    );
  }
  return result.stdout ?? "";
}

/**
 * Resolve the actual on-host docker volume name for a compose-declared volume.
 * Uses `docker compose config --format json` which reports `volumes.<key>.name`
 * with the project prefix applied. Falls back to `<projectname>_<key>` derived
 * from the cwd basename.
 */
export async function resolveVolumeNames(
  ctx: ComposeContext,
  declaredNames: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (declaredNames.length === 0) return out;
  try {
    const stdout = await dockerCompose(ctx, ["config", "--format", "json"]);
    const parsed = JSON.parse(stdout) as {
      name?: string;
      volumes?: Record<string, { name?: string }>;
    };
    for (const declared of declaredNames) {
      const entry = parsed.volumes?.[declared];
      if (entry?.name) {
        out.set(declared, entry.name);
      } else if (parsed.name) {
        out.set(declared, `${parsed.name}_${declared}`);
      } else {
        out.set(declared, declared);
      }
    }
  } catch {
    // Fall back to docker's default project-name derivation: lowercased
    // basename of the compose-file directory with non-alphanumerics stripped.
    const base = ctx.cwd.split(/[\\/]/).pop() ?? "openmapx";
    const project = base.toLowerCase().replace(/[^a-z0-9_]/g, "");
    for (const declared of declaredNames) {
      out.set(declared, `${project}_${declared}`);
    }
  }
  return out;
}

/**
 * Returns the set of currently-running service ids in the compose project.
 */
export async function listRunningServices(ctx: ComposeContext): Promise<Set<string>> {
  const stdout = await dockerCompose(ctx, ["ps", "--status=running", "--format", "json"]);
  const running = new Set<string>();
  // `docker compose ps --format json` emits one JSON object per line.
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as { Service?: string };
      if (obj.Service) running.add(obj.Service);
    } catch {
      // ignore malformed lines
    }
  }
  return running;
}

async function waitForPostgres(
  ctx: ComposeContext,
  serviceId: string,
  user: string,
  database: string,
): Promise<void> {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const result = await execa(
      "docker",
      [
        "compose",
        "-f",
        ctx.composeFile,
        "exec",
        "-T",
        serviceId,
        "pg_isready",
        "-U",
        user,
        "-d",
        database,
        "-t",
        "1",
      ],
      { cwd: ctx.cwd, reject: false, timeout: 5_000 },
    );
    if (result.exitCode === 0) return;
    if (attempt < 30) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`PostgreSQL did not become ready for erasure replay (${serviceId})`);
}

// ─── File-size helper ──────────────────────────────────────────────────────

function safeSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Flush a directory entry after an atomic rename.  Directory fsync is
 * supported by the Linux hosts used for deployments; if it is unavailable the
 * caller receives an error instead of reporting a manifest as durable. */
function fsyncDirectory(directory: string): void {
  const descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Write a backup manifest as one private, durable publication.  A partial
 * manifest must never be mistaken for a valid inventory entry, and a reader
 * must never observe a half-written JSON document. */
export function writeBackupManifestAtomically(filePath: string, manifest: BackupManifest): void {
  const directory = dirname(filePath);
  const temporary = join(
    directory,
    `.manifest-${process.pid}-${randomBytes(16).toString("hex")}.partial`,
  );
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, serialized, "utf8");
    fsyncSync(descriptor);
    chmodSync(temporary, 0o400);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, filePath);
    fsyncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        /* best effort before removing this exact temporary name */
      }
    }
    try {
      unlinkSync(temporary);
    } catch {
      /* the rename may already have published the manifest */
    }
    throw error;
  }
}

// ─── Create ────────────────────────────────────────────────────────────────

export interface CreateBackupOptions {
  rootDir?: string;
  name?: string;
}

export interface CreateBackupResult {
  name: string;
  directory: string;
  manifest: BackupManifest;
}

export async function createBackup(opts: CreateBackupOptions = {}): Promise<CreateBackupResult> {
  const name = opts.name ?? defaultBackupName();
  assertValidBackupName(name);
  // Validate policy before creating files or stopping services.
  const retentionDays = configuredBackupRetentionDays();

  const backupDir = resolveBackupDir(opts.rootDir, name);

  if (existsSync(backupDir)) {
    throw new Error(`Backup directory already exists: ${backupDir}`);
  }

  const targets = await discoverBackupableServices({ rootDir: opts.rootDir });
  if (targets.length === 0) {
    throw new Error(
      "No services with backup-enabled volumes were found (none have volumes[].backup = true).",
    );
  }

  const ctx = ctxFromRepo(opts.rootDir);

  // Resolve docker-side volume names up-front so a missing compose file fails
  // before we mutate anything.
  const declaredNames: string[] = [];
  for (const svc of targets) {
    for (const v of svc.volumes) {
      if (v.mode === "tar") declaredNames.push(v.volumeName);
    }
  }
  const volumeNames = await resolveVolumeNames(ctx, declaredNames);

  mkdirSync(backupDir, { recursive: true, mode: 0o700 });

  const stoppedServices: string[] = [];
  const cleanupHandlers: Array<() => Promise<void> | void> = [];

  // Best-effort cleanup on Ctrl+C: restart any services we stopped, then
  // remove the partial backup directory.
  const onSignal = async () => {
    log.warn("Interrupted — rolling back…");
    for (const id of stoppedServices) {
      try {
        await dockerCompose(ctx, ["start", id]);
      } catch (err) {
        log.warn(`Failed to restart ${id}: ${(err as Error).message}`);
      }
    }
    try {
      rmSync(backupDir, { recursive: true, force: true });
    } catch {}
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  cleanupHandlers.push(() => {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  });

  const manifest: BackupManifest = {
    formatVersion: 2,
    name,
    createdAt: new Date().toISOString(),
    openmapxVersion: PLATFORM_VERSION,
    services: [],
    ...(targets.some((service) => service.id === "dawarich-postgis")
      ? {
          privacySourceProvenance: {
            managedDawarich: {
              version: "1.15.2",
              image: "freikin/dawarich",
              imageDigest:
                "sha256:e58334ca56976feb4c885a8bd34b251ec2e3f45ffeabd4fd4371b5d2108fc70d",
              upstreamCommit: "d81abc4fc467e119f542c56602c78488fbab86fb",
              schemaContract: "dawarich-1.15.2",
            },
          },
        }
      : {}),
  };

  try {
    for (const svc of targets) {
      log.info(kleur.bold(`◆ ${svc.id}`));
      const serviceEntry: BackupServiceEntry = { id: svc.id, version: svc.version, volumes: [] };

      for (const v of svc.volumes.filter((volume) => volume.mode === "pg_dump")) {
        // Postgres: pg_dump while running. One dump file per declared volume
        // keeps the manifest schema simple even though the volume is just a
        // marker for "this service has data to back up".
        const file = `${svc.id}__${v.volumeName}.sql.gz`;
        const out = join(backupDir, file);
        const user = svc.postgresUser ?? "postgres";
        const db = svc.postgresDb ?? "openmapx";
        if (!isSafePostgresIdentifier(user) || !isSafePostgresIdentifier(db)) {
          throw new Error(
            `Service "${svc.id}" declares pg_dump backup data without safe literal POSTGRES_USER and POSTGRES_DB values`,
          );
        }
        log.dim(`  pg_dump ${db} (user=${user}) → ${file}`);
        await pgDumpToFile(ctx, svc.id, user, db, out);
        serviceEntry.volumes.push({
          name: v.volumeName,
          mode: "pg_dump",
          file,
          sizeBytes: safeSize(out),
          sha256: await sha256File(out),
          // Persist the credentials so restore can target the same
          // database/user even if the manifest changes later.
          postgresUser: user,
          postgresDb: db,
        });
      }

      for (const v of svc.volumes.filter((volume) => volume.mode === "tar")) {
        const realVol = volumeNames.get(v.volumeName) ?? v.volumeName;
        const file = `${svc.id}__${v.volumeName}.tar.gz`;
        const out = join(backupDir, file);

        if (!stoppedServices.includes(svc.id)) {
          log.dim(`  stopping ${svc.id}…`);
          await dockerCompose(ctx, ["stop", svc.id]);
          stoppedServices.push(svc.id);
        }

        log.dim(`  tar ${realVol} → ${file}`);
        await tarVolumeToFile(realVol, backupDir, file);

        serviceEntry.volumes.push({
          name: v.volumeName,
          // Persist the resolved on-host volume name so restore works even
          // if the compose project name changes between backup and restore.
          resolvedName: realVol,
          mode: "tar",
          file,
          sizeBytes: safeSize(out),
          sha256: await sha256File(out),
        });
      }

      manifest.services.push(serviceEntry);
    }

    writeBackupManifestAtomically(join(backupDir, "manifest.json"), manifest);

    // Restart the services we stopped (in reverse order — closer to original
    // dependency direction).
    for (const id of [...stoppedServices].reverse()) {
      log.dim(`  starting ${id}…`);
      await dockerCompose(ctx, ["start", id]);
    }

    const totalBytes = manifest.services
      .flatMap((s) => s.volumes.map((v) => v.sizeBytes))
      .reduce((a, b) => a + b, 0);
    const volCount = manifest.services.reduce((n, s) => n + s.volumes.length, 0);
    log.ok(
      `Backup ${kleur.bold(name)} created — ${volCount} volumes, ${formatBytes(totalBytes)} total`,
    );

    try {
      const pruned = pruneExpiredBackups({ rootDir: opts.rootDir, retentionDays });
      if (pruned.deleted.length > 0) {
        log.info(`Pruned ${pruned.deleted.length} backup(s) outside the retention period`);
      }
    } catch (error) {
      // The completed backup remains valid; the scheduled operations-agent
      // prune will retry instead of rolling back the new backup.
      log.warn(`Backup created but retention prune failed: ${(error as Error).message}`);
    }

    return { name, directory: backupDir, manifest };
  } catch (err) {
    // Roll back: restart stopped services, then remove the partial dir.
    log.err(`Backup failed: ${(err as Error).message}`);
    for (const id of [...stoppedServices].reverse()) {
      try {
        await dockerCompose(ctx, ["start", id]);
      } catch (e) {
        log.warn(`Failed to restart ${id}: ${(e as Error).message}`);
      }
    }
    try {
      rmSync(backupDir, { recursive: true, force: true });
    } catch {}
    throw err;
  } finally {
    for (const h of cleanupHandlers) {
      try {
        await h();
      } catch {}
    }
  }
}

async function pgDumpToFile(
  ctx: ComposeContext,
  serviceId: string,
  user: string,
  db: string,
  outFile: string,
): Promise<void> {
  // `docker compose exec -T <svc> pg_dump -U <user> <db>` streamed
  // through Node's zlib gzip into outFile.
  //
  // Earlier this used `execa(... gzip ...)` with `input: sub.stdout`, but
  // execa v9 buffers each child's stdout into its result object by
  // default — so even though gzip was the real consumer, the dump was
  // also being held in memory and OOM-killed Node on multi-hundred-MB
  // dumps. Stream directly via createGzip() + pipeline() so nothing
  // touches the JS heap and we skip the extra `gzip` subprocess.
  const sub = execa(
    "docker",
    [
      "compose",
      "-f",
      ctx.composeFile,
      "exec",
      "-T",
      serviceId,
      "pg_dump",
      "-U",
      user,
      "--no-owner",
      "--no-privileges",
      db,
    ],
    { cwd: ctx.cwd, reject: false, stderr: "pipe", buffer: { stdout: false } },
  );

  if (!sub.stdout) {
    throw new Error("pg_dump subprocess has no stdout stream");
  }

  const out = createWriteStream(outFile, { mode: 0o600 });
  const gzip = createGzip();

  // Run the stream pipeline and the subprocess wait in parallel; both
  // must succeed before the dump is considered complete.
  const pipePromise = pipeline(sub.stdout, gzip, out);
  const [pgRes] = await Promise.all([sub, pipePromise]);
  if (pgRes.exitCode !== 0) {
    throw new Error(`pg_dump failed (exit ${pgRes.exitCode}): ${pgRes.stderr ?? ""}`);
  }
}

async function tarVolumeToFile(
  volumeName: string,
  backupDir: string,
  fileName: string,
): Promise<void> {
  const result = await execa(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${volumeName}:/source:ro`,
      "-v",
      `${backupDir}:/backup`,
      "alpine",
      "tar",
      "-czf",
      `/backup/${fileName}`,
      "-C",
      "/source",
      ".",
    ],
    { reject: false },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `tar of volume ${volumeName} failed (exit ${result.exitCode}): ${result.stderr ?? ""}`,
    );
  }
  const output = join(backupDir, fileName);
  if (!existsSync(output) || !lstatSync(output).isFile() || lstatSync(output).nlink !== 1) {
    throw new Error(`tar of volume ${volumeName} did not create ${fileName}`);
  }
}

// ─── List ──────────────────────────────────────────────────────────────────

export interface ListedBackup {
  name: string;
  manifest: BackupManifest;
  totalBytes: number;
}

export interface ListBackupsOptions {
  rootDir?: string;
  /**
   * Called once per skipped entry (missing/malformed manifest.json). Defaults
   * to `log.warn` so the CLI surfaces issues to stderr; a programmatic caller
   * (e.g. an admin endpoint) can pass a no-op or collect into an array.
   */
  onWarning?: (message: string) => void;
}

export function listBackups(opts: ListBackupsOptions = {}): ListedBackup[] {
  const paths = repoPaths(opts.rootDir);
  const backupsRoot = join(paths.infraDir, "backups");
  if (!existsSync(backupsRoot)) return [];

  const onWarning = opts.onWarning ?? ((msg: string) => log.warn(msg));

  const out: ListedBackup[] = [];
  for (const entry of readdirSync(backupsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(backupsRoot, entry.name, "manifest.json");
    if (!existsSync(manifestPath)) {
      onWarning(`skipping ${entry.name}: no manifest.json`);
      continue;
    }
    try {
      const manifest = readBackupManifest(manifestPath);
      const totalBytes = manifest.services
        .flatMap((s) => s.volumes.map((v) => v.sizeBytes))
        .reduce((a, b) => a + b, 0);
      out.push({ name: entry.name, manifest, totalBytes });
    } catch (err) {
      onWarning(`skipping ${entry.name}: ${(err as Error).message}`);
    }
  }
  return out.sort((a, b) => a.manifest.createdAt.localeCompare(b.manifest.createdAt));
}

export function formatBackupsTable(rows: ListedBackup[]): string {
  if (rows.length === 0) return "(no backups)";
  return table(
    [
      { key: "name", header: "Name" },
      { key: "createdAt", header: "Created" },
      { key: "services", header: "Services" },
      { key: "volumes", header: "Volumes" },
      { key: "size", header: "Size" },
    ],
    rows.map((r) => ({
      name: r.name,
      createdAt: r.manifest.createdAt,
      services: String(r.manifest.services.length),
      volumes: String(r.manifest.services.reduce((n, s) => n + s.volumes.length, 0)),
      size: formatBytes(r.totalBytes),
    })),
  );
}

export interface PruneExpiredBackupsOptions {
  rootDir?: string;
  retentionDays: number;
  now?: Date;
  onWarning?: (message: string) => void;
}

export interface PruneExpiredBackupsResult {
  deleted: string[];
  retained: string[];
}

export function pruneExpiredBackups(opts: PruneExpiredBackupsOptions): PruneExpiredBackupsResult {
  if (
    !Number.isSafeInteger(opts.retentionDays) ||
    opts.retentionDays <= 0 ||
    opts.retentionDays > 36_500
  ) {
    throw new Error("Backup retention days must be an integer between 1 and 36500");
  }
  const now = (opts.now ?? new Date()).getTime();
  const cutoff = now - opts.retentionDays * 24 * 60 * 60 * 1000;
  const deleted: string[] = [];
  const retained: string[] = [];
  const backupsRoot = join(repoPaths(opts.rootDir).infraDir, "backups");
  if (!existsSync(backupsRoot)) return { deleted, retained };
  for (const entry of readdirSync(backupsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isValidBackupName(entry.name)) continue;
    const backupDir = resolveBackupDir(opts.rootDir, entry.name);
    const directoryStats = lstatSync(backupDir);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) continue;
    let timestamp = directoryStats.mtimeMs;
    try {
      const manifest = readBackupManifest(join(backupDir, "manifest.json"));
      const createdAt = Date.parse(manifest.createdAt);
      if (Number.isFinite(createdAt) && createdAt <= now) timestamp = createdAt;
      else opts.onWarning?.(`using directory age for ${entry.name}: invalid creation timestamp`);
    } catch (error) {
      opts.onWarning?.(`using directory age for ${entry.name}: ${(error as Error).message}`);
    }
    if (timestamp < cutoff) {
      deleteBackup({ rootDir: opts.rootDir, name: entry.name });
      deleted.push(entry.name);
    } else {
      retained.push(entry.name);
    }
  }
  deleted.sort();
  retained.sort();
  return { deleted, retained };
}

function configuredBackupRetentionDays(): number {
  const raw = process.env.BACKUP_RETENTION_DAYS?.trim() || "30";
  const days = Number(raw);
  if (!Number.isSafeInteger(days) || days <= 0 || days > 36_500) {
    throw new Error("BACKUP_RETENTION_DAYS must be an integer between 1 and 36500");
  }
  return days;
}

function containsOpenMapXDatabase(manifest: BackupManifest): boolean {
  return manifest.services.some((service) =>
    service.volumes.some((volume) => volume.mode === "pg_dump" && volume.postgresDb === "openmapx"),
  );
}

const PRIVATE_SUBJECT_EXPORT_VOLUME = "openmapx-subject-exports";

function assertNoPrivateSubjectExportRestore(manifest: BackupManifest): void {
  const privateVolume = manifest.services
    .flatMap((service) => service.volumes)
    .find(
      (volume) =>
        volume.mode === "tar" &&
        (volume.name === PRIVATE_SUBJECT_EXPORT_VOLUME ||
          volume.resolvedName === PRIVATE_SUBJECT_EXPORT_VOLUME ||
          volume.resolvedName?.endsWith(`_${PRIVATE_SUBJECT_EXPORT_VOLUME}`)),
    );
  if (privateVolume) {
    throw new Error(
      "The private subject-export ciphertext volume must not be restored from a backup",
    );
  }
}

/**
 * Services outside the restore manifest that must be isolated while the
 * account database is restored. Keeping the API stopped prevents a deleted
 * account from becoming observable between pg_restore and erasure replay.
 */
export function requiredDependentStops(
  manifest: BackupManifest,
  running: ReadonlySet<string>,
): string[] {
  return containsOpenMapXDatabase(manifest) && running.has("app-api") ? ["app-api"] : [];
}

function erasureJournalPaths(rootDir?: string): { journalPath: string; keyPath: string } {
  const infraDir = repoPaths(rootDir).infraDir;
  return {
    journalPath: join(infraDir, "data", "erasure", "journal.jsonl"),
    keyPath: join(infraDir, "secrets", "erasure-journal-key"),
  };
}

function readErasureJournalKey(rootDir?: string): Buffer {
  const { journalPath, keyPath } = erasureJournalPaths(rootDir);
  const parent = lstatSync(dirname(journalPath));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o7777) !== 0o700) {
    throw new Error("Erasure journal parent must be a protected 0700 directory");
  }
  return readErasureJournalKeyFile(keyPath, parent.uid);
}

export function validateRestoreDataProtection(
  manifest: BackupManifest,
  opts: { rootDir?: string; retentionDays?: number; now?: Date } = {},
): void {
  if (!containsOpenMapXDatabase(manifest)) return;
  const retentionDays = opts.retentionDays ?? configuredBackupRetentionDays();
  if (!Number.isSafeInteger(retentionDays) || retentionDays <= 0 || retentionDays > 36_500) {
    throw new Error("Backup retention days must be an integer between 1 and 36500");
  }
  const createdAt = Date.parse(manifest.createdAt);
  if (!Number.isFinite(createdAt)) throw new Error("Backup has an invalid creation timestamp");
  const now = (opts.now ?? new Date()).getTime();
  if (createdAt < now - retentionDays * 24 * 60 * 60 * 1000) {
    throw new Error(
      `Backup exceeds the ${retentionDays}-day retention policy and cannot be restored`,
    );
  }
  const { journalPath } = erasureJournalPaths(opts.rootDir);
  const key = readErasureJournalKey(opts.rootDir);
  const journal = readErasureJournal(journalPath, key);
  assertErasureJournalKey(journal, key);
  if (createdAt < journal.coverageStartedAt.getTime()) {
    throw new Error("Backup predates erasure journal coverage and cannot be restored safely");
  }
}

interface RestoredUser {
  id: string;
  email: string;
}

export async function replayErasureRequests(opts: {
  journalPath: string;
  key: Uint8Array;
  listUsers(): Promise<RestoredUser[]>;
  eraseUser(user: RestoredUser): Promise<void>;
}): Promise<number> {
  const journal = readErasureJournal(opts.journalPath, opts.key);
  assertErasureJournalKey(journal, opts.key);
  const users = await opts.listUsers();
  let erased = 0;
  for (const user of users) {
    if (!isErasedSubject(journal, opts.key, user.id)) continue;
    await opts.eraseUser(user);
    erased += 1;
  }
  return erased;
}

async function listRestoredUsers(
  ctx: ComposeContext,
  serviceId: string,
  user: string,
  database: string,
): Promise<RestoredUser[]> {
  const result = await execa(
    "docker",
    [
      "compose",
      "-f",
      ctx.composeFile,
      "exec",
      "-T",
      serviceId,
      "psql",
      "-U",
      user,
      "-d",
      database,
      "-At",
      "-c",
      `SELECT json_build_object('id', id, 'email', email)::text FROM "user"`,
    ],
    { cwd: ctx.cwd, reject: false, maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.exitCode !== 0)
    throw new Error(`Unable to enumerate restored users: ${result.stderr}`);
  return (result.stdout ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parsed = JSON.parse(line) as Partial<RestoredUser>;
      if (typeof parsed.id !== "string" || typeof parsed.email !== "string") {
        throw new Error("Restored user query returned invalid data");
      }
      return { id: parsed.id, email: parsed.email };
    });
}

async function eraseRestoredUser(
  ctx: ComposeContext,
  serviceId: string,
  postgresUser: string,
  database: string,
  restoredUser: RestoredUser,
): Promise<void> {
  const [emailIdentifier, changeEmailIdentifier] = erasureVerificationIdentifiers(restoredUser);
  const copyRow = [restoredUser.id, restoredUser.email, emailIdentifier, changeEmailIdentifier]
    .map(postgresCopyTextField)
    .join("\t");
  const terminalStates = TERMINAL_PRIVACY_REQUEST_STATES.map(postgresSqlLiteral).join(", ");
  const statement = `BEGIN;
CREATE TEMP TABLE _openmapx_erasure_subject (
  user_id text NOT NULL,
  user_email text NOT NULL,
  verification_email text NOT NULL,
  verification_change_email text NOT NULL
) ON COMMIT DROP;
COPY _openmapx_erasure_subject (
  user_id, user_email, verification_email, verification_change_email
) FROM STDIN;
${copyRow}
\\.
UPDATE data_subject_request request
SET account_state = 'deleted',
    version = request.version + 1,
    updated_at = CURRENT_TIMESTAMP
FROM _openmapx_erasure_subject subject
WHERE request.user_id = subject.user_id
  AND request.account_state <> 'deleted';
UPDATE data_export_artifact artifact
SET state = 'revoked',
    revoked_at = COALESCE(artifact.revoked_at, CURRENT_TIMESTAMP),
    deleted_at = NULL
FROM data_subject_request request, _openmapx_erasure_subject subject
WHERE artifact.request_id = request.id
  AND request.user_id = subject.user_id
  AND request.state IN (${terminalStates})
  AND (artifact.state <> 'deleted' OR artifact.wrapped_dek IS NOT NULL);
UPDATE data_subject_request_attachment attachment
SET expires_at = LEAST(attachment.expires_at, CURRENT_TIMESTAMP),
    deleted_at = NULL
FROM data_subject_request request, _openmapx_erasure_subject subject
WHERE attachment.request_id = request.id
  AND request.user_id = subject.user_id
  AND request.state IN (${terminalStates})
  AND (attachment.deleted_at IS NULL OR attachment.wrapped_dek IS NOT NULL);
UPDATE data_subject_request_source_snapshot snapshot
SET state = 'captured',
    expires_at = LEAST(snapshot.expires_at, CURRENT_TIMESTAMP),
    deleted_at = NULL
FROM data_subject_request request, _openmapx_erasure_subject subject
WHERE snapshot.request_id = request.id
  AND request.user_id = subject.user_id
  AND request.state IN (${terminalStates})
  AND (snapshot.state <> 'deleted' OR snapshot.wrapped_dek IS NOT NULL);
DELETE FROM verification verification
USING _openmapx_erasure_subject subject
WHERE verification.value = subject.user_id
   OR lower(verification.identifier) = lower(subject.verification_email)
   OR lower(verification.identifier) = lower(subject.verification_change_email);
UPDATE system_settings settings
SET updated_by = NULL
FROM _openmapx_erasure_subject subject
WHERE settings.updated_by = subject.user_id;
UPDATE admin_audit_log audit
SET actor_id = NULL, ip_address = NULL, user_agent = NULL
FROM _openmapx_erasure_subject subject
WHERE audit.actor_id = subject.user_id;
UPDATE admin_audit_log audit
SET target_id = NULL
FROM _openmapx_erasure_subject subject
WHERE audit.target_id = subject.user_id;
UPDATE admin_audit_log audit
SET details = NULL
FROM _openmapx_erasure_subject subject
WHERE position(subject.user_id in audit.details::text) > 0
   OR position(lower(subject.user_email) in lower(audit.details::text)) > 0;
DELETE FROM app_logs logs
USING _openmapx_erasure_subject subject
WHERE position(subject.user_id in logs.msg) > 0
   OR position(lower(subject.user_email) in lower(logs.msg)) > 0
   OR position(subject.user_id in logs.metadata::text) > 0
   OR position(lower(subject.user_email) in lower(logs.metadata::text)) > 0;
DELETE FROM "user" restored_user
USING _openmapx_erasure_subject subject
WHERE restored_user.id = subject.user_id;
COMMIT;
`;
  const result = await execa(
    "docker",
    [
      "compose",
      "-f",
      ctx.composeFile,
      "exec",
      "-T",
      serviceId,
      "psql",
      "-U",
      postgresUser,
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { cwd: ctx.cwd, reject: false, input: statement },
  );
  if (result.exitCode !== 0) {
    throw new Error(`Unable to replay user erasure (psql exit ${result.exitCode})`);
  }
}

function postgresCopyTextField(value: string): string {
  if (value.includes("\0")) throw new Error("Restored user query returned invalid data");
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .split("\u0008")
    .join("\\b")
    .replace(/\f/g, "\\f")
    .split("\u000b")
    .join("\\v");
}

function postgresSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function replayOpenMapXErasures(
  ctx: ComposeContext,
  rootDir: string | undefined,
  serviceId: string,
  postgresUser: string,
  database: string,
): Promise<number> {
  const { journalPath } = erasureJournalPaths(rootDir);
  return replayErasureRequests({
    journalPath,
    key: readErasureJournalKey(rootDir),
    listUsers: () => listRestoredUsers(ctx, serviceId, postgresUser, database),
    eraseUser: (restoredUser) =>
      eraseRestoredUser(ctx, serviceId, postgresUser, database, restoredUser),
  });
}

// ─── Restore ───────────────────────────────────────────────────────────────

export interface RestoreOptions {
  rootDir?: string;
  name: string;
  serviceIds?: string[];
  stopRunning?: boolean;
}

export interface RestorePreflight {
  manifest: BackupManifest;
  backupDir: string;
  /** Services from the (possibly --services-filtered) manifest. */
  targets: BackupServiceEntry[];
  /** Whether the backed-up version requires a major-mismatch error. */
  versionError?: string;
  versionWarning?: string;
}

/**
 * Synchronous, no-docker preflight: validates the backup name, loads + filters
 * the manifest, and performs the version-compatibility check. Tested directly.
 */
export function preflightRestore(opts: RestoreOptions): RestorePreflight {
  assertValidBackupName(opts.name);
  const backupDir = resolveBackupDir(opts.rootDir, opts.name);
  const manifestPath = join(backupDir, "manifest.json");
  let manifest = readBackupManifest(manifestPath);

  if (opts.serviceIds && opts.serviceIds.length > 0) {
    manifest = filterManifestServices(manifest, opts.serviceIds);
  }
  assertNoPrivateSubjectExportRestore(manifest);

  let versionError: string | undefined;
  let versionWarning: string | undefined;
  const cmp = isCompatiblePlatformVersion(manifest.openmapxVersion);
  if (!cmp.compatible) {
    versionError =
      `Backup was created on platform ${manifest.openmapxVersion} ` +
      `but current platform is ${PLATFORM_VERSION} — major-version mismatch, refusing to restore.`;
  } else if (cmp.minorMismatch) {
    versionWarning =
      `Backup created on platform ${manifest.openmapxVersion}; current is ${PLATFORM_VERSION} ` +
      `(minor mismatch — proceeding).`;
  }

  return {
    manifest,
    backupDir,
    targets: manifest.services,
    versionError,
    versionWarning,
  };
}

export async function restoreBackup(opts: RestoreOptions): Promise<void> {
  const pre = preflightRestore(opts);
  if (pre.versionError) throw new Error(pre.versionError);
  if (pre.versionWarning) log.warn(pre.versionWarning);
  validateRestoreDataProtection(pre.manifest, { rootDir: opts.rootDir });

  const ctx = ctxFromRepo(opts.rootDir);
  const running = await listRunningServices(ctx);
  const runningTarTargets = pre.targets
    .filter((service) => service.volumes.some((volume) => volume.mode === "tar"))
    .map((service) => service.id)
    .filter((id) => running.has(id));
  const dependentStops = requiredDependentStops(pre.manifest, running);
  const requiredStops = [...new Set([...runningTarTargets, ...dependentStops])];
  if (requiredStops.length > 0 && !opts.stopRunning) {
    throw new Error(
      `Refusing to restore — these services must be stopped: ${requiredStops.join(
        ", ",
      )}. Pass --stop-running to stop them automatically.`,
    );
  }

  const stopped: string[] = [];
  const active = new Set(running);
  const startedForRestore = new Set<string>();
  const protectedDatabases: Array<{
    serviceId: string;
    postgresUser: string;
    database: string;
  }> = [];
  let protectedDatabaseSafe = true;
  try {
    for (const id of dependentStops) {
      log.dim(`  stopping ${id} to isolate account-database restore…`);
      await dockerCompose(ctx, ["stop", id]);
      active.delete(id);
      stopped.push(id);
    }

    // The API is now isolated. Re-read the key-bound journal immediately
    // before restoring the account database so a swapped key/journal cannot
    // pass the earlier no-Docker preflight and then disable replay.
    validateRestoreDataProtection(pre.manifest, { rootDir: opts.rootDir });

    for (const svc of pre.targets) {
      log.info(kleur.bold(`◆ ${svc.id}`));
      const pgVolumes = svc.volumes.filter((volume) => volume.mode === "pg_dump");
      const tarVolumes = svc.volumes.filter((volume) => volume.mode === "tar");

      for (const vol of pgVolumes) {
        // Defense-in-depth backstop for the filename validation in readBackupManifest.
        const file = resolve(pre.backupDir, vol.file);
        if (!file.startsWith(`${resolve(pre.backupDir)}/`)) {
          throw new Error(`Refusing to read a backup file outside ${pre.backupDir}: ${file}`);
        }
        if (!existsSync(file)) throw new Error(`Backup file missing: ${file}`);
        await verifyBackupVolumeFile(vol, pre.backupDir);

        // pg_dump restores require a live server. A service can use this mode
        // regardless of its id, so never infer the behavior from `postgis`.
        if (!active.has(svc.id)) {
          log.dim(`  starting ${svc.id} for restore…`);
          await dockerCompose(ctx, ["start", svc.id]);
          active.add(svc.id);
          if (!running.has(svc.id)) startedForRestore.add(svc.id);
        }
        if (!vol.postgresUser || !vol.postgresDb) {
          throw new Error(
            `Backup entry ${vol.name} is missing postgres credentials — re-create the backup.`,
          );
        }
        const user = vol.postgresUser;
        const db = vol.postgresDb;
        log.dim(`  restoring database ${db} (user=${user}) from ${vol.file}…`);
        if (db === "openmapx") protectedDatabaseSafe = false;
        await pgRestoreFromFile(ctx, svc.id, file, user, db);
        if (db === "openmapx") {
          protectedDatabases.push({ serviceId: svc.id, postgresUser: user, database: db });
        }
      }

      if (tarVolumes.length > 0 && active.has(svc.id)) {
        log.dim(`stopping ${svc.id}…`);
        await dockerCompose(ctx, ["stop", svc.id]);
        active.delete(svc.id);
        if (running.has(svc.id)) stopped.push(svc.id);
      }

      for (const vol of tarVolumes) {
        const file = resolve(pre.backupDir, vol.file);
        if (!file.startsWith(`${resolve(pre.backupDir)}/`)) {
          throw new Error(`Refusing to read a backup file outside ${pre.backupDir}: ${file}`);
        }
        if (!existsSync(file)) throw new Error(`Backup file missing: ${file}`);
        await verifyBackupVolumeFile(vol, pre.backupDir);
        if (!vol.resolvedName) {
          throw new Error(
            `Backup entry ${vol.name} is missing its resolved docker volume name — re-create the backup.`,
          );
        }
        log.dim(`  restoring volume ${vol.resolvedName} from ${vol.file}…`);
        await tarRestoreFromFile(vol.resolvedName, pre.backupDir, vol.file);
      }
    }

    // Replay only after every archive has been restored. This prevents a tar
    // target later in the manifest from reintroducing state after quarantine.
    for (const target of protectedDatabases) {
      if (!active.has(target.serviceId)) {
        log.dim(`  starting ${target.serviceId} for erasure replay…`);
        await dockerCompose(ctx, ["start", target.serviceId]);
        active.add(target.serviceId);
        await waitForPostgres(ctx, target.serviceId, target.postgresUser, target.database);
      }
      const erased = await replayOpenMapXErasures(
        ctx,
        opts.rootDir,
        target.serviceId,
        target.postgresUser,
        target.database,
      );
      log.dim(`  replayed ${erased} retained user-erasure request(s)`);
      if (startedForRestore.has(target.serviceId)) {
        log.dim(`  stopping ${target.serviceId} after erasure replay…`);
        await dockerCompose(ctx, ["stop", target.serviceId]);
        active.delete(target.serviceId);
      }
    }
    protectedDatabaseSafe = true;

    // Restart everything we stopped.
    for (const id of [...stopped].reverse()) {
      if (active.has(id)) continue;
      log.dim(`  starting ${id}…`);
      await dockerCompose(ctx, ["start", id]);
      active.add(id);
    }

    const volCount = pre.targets.reduce((n, s) => n + s.volumes.length, 0);
    log.ok(
      `Restore of ${kleur.bold(opts.name)} complete — ${pre.targets.length} services, ${volCount} volumes`,
    );
  } catch (err) {
    log.err(`Restore failed: ${(err as Error).message}`);
    // Best-effort restart of everything we stopped, even on failure.
    for (const id of [...stopped].reverse()) {
      if (id === "app-api" && !protectedDatabaseSafe) {
        log.warn(
          "Leaving app-api stopped because the account database was not safely replayed after restore",
        );
        continue;
      }
      try {
        await dockerCompose(ctx, ["start", id]);
      } catch (e) {
        log.warn(`Failed to restart ${id}: ${(e as Error).message}`);
      }
    }
    throw err;
  }
}

async function pgRestoreFromFile(
  ctx: ComposeContext,
  serviceId: string,
  gzFile: string,
  user: string,
  db: string,
): Promise<void> {
  // The `pg_dump` we wrote at backup time uses defaults (no `--clean
  // --if-exists --create`), so the dump itself doesn't drop or recreate the
  // database — it's just `CREATE TABLE …` etc. We therefore drop + create
  // the target DB up-front to give the dump a clean slate. The `postgis/
  // postgis` images preload PostGIS into `template1`, so `createdb` produces
  // a PostGIS-enabled database without needing an explicit
  // `CREATE EXTENSION` step.
  const drop = await execa(
    "docker",
    [
      "compose",
      "-f",
      ctx.composeFile,
      "exec",
      "-T",
      serviceId,
      "dropdb",
      "-U",
      user,
      "--if-exists",
      db,
    ],
    { cwd: ctx.cwd, reject: false },
  );
  if (drop.exitCode !== 0) {
    throw new Error(`dropdb failed: ${drop.stderr ?? ""}`);
  }

  const create = await execa(
    "docker",
    ["compose", "-f", ctx.composeFile, "exec", "-T", serviceId, "createdb", "-U", user, db],
    { cwd: ctx.cwd, reject: false },
  );
  if (create.exitCode !== 0) {
    throw new Error(`createdb failed: ${create.stderr ?? ""}`);
  }

  // gunzip <file> | docker compose exec -T <svc> psql -U <user> <db>
  const gunzip = execa("gunzip", ["-c", gzFile], {
    cwd: ctx.cwd,
    reject: false,
    stdout: "pipe",
  });
  const psql = execa(
    "docker",
    [
      "compose",
      "-f",
      ctx.composeFile,
      "exec",
      "-T",
      serviceId,
      "psql",
      "-U",
      user,
      "-v",
      "ON_ERROR_STOP=1",
      db,
    ],
    { cwd: ctx.cwd, reject: false, input: gunzip.stdout ?? undefined },
  );

  const [gunzipRes, psqlRes] = await Promise.all([gunzip, psql]);
  if (gunzipRes.exitCode !== 0) {
    throw new Error(`gunzip failed: ${gunzipRes.stderr ?? ""}`);
  }
  if (psqlRes.exitCode !== 0) {
    throw new Error(`psql restore failed: ${psqlRes.stderr ?? ""}`);
  }
}

async function tarRestoreFromFile(
  volumeName: string,
  backupDir: string,
  fileName: string,
): Promise<void> {
  const result = await execa(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${volumeName}:/target`,
      "-v",
      `${backupDir}:/backup:ro`,
      "alpine",
      "sh",
      "-c",
      // Wipe the volume contents (including dotfiles), then untar. We do NOT
      // swallow `find` errors here — a permission/read-only failure during
      // the wipe is a real problem and we want it to surface rather than
      // silently leaving stale files for tar to layer on top of.
      `cd /target && find . -mindepth 1 -delete && ` +
        `tar -xzf /backup/${shellEscape(fileName)} -C /target`,
    ],
    { reject: false },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `tar restore of volume ${volumeName} failed (exit ${result.exitCode}): ${result.stderr ?? ""}`,
    );
  }
}

/**
 * Minimal shell escape for a filename embedded in the `sh -c` payload above.
 * We already validate filenames via the `<name>` regex (and the file name
 * itself is `<id>__<volname>.tar.gz` — controlled), but defense-in-depth.
 */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ─── Delete ────────────────────────────────────────────────────────────────

export interface DeleteBackupOptions {
  rootDir?: string;
  name: string;
}

export function deleteBackup(opts: DeleteBackupOptions): void {
  assertValidBackupName(opts.name);
  const backupDir = resolveBackupDir(opts.rootDir, opts.name);
  if (!existsSync(backupDir)) {
    throw new Error(`Backup not found: ${opts.name}`);
  }
  const stats = lstatSync(backupDir);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Backup is not a safe directory: ${opts.name}`);
  }
  rmSync(backupDir, { recursive: true, force: true });
  log.ok(`Deleted backup ${kleur.bold(opts.name)}`);
}

// ─── Command registration ──────────────────────────────────────────────────

export function registerBackupCommands(program: Command): void {
  const backup = program
    .command("backup")
    .description("Create, list, restore, prune, and delete on-disk backups of service volumes");

  backup
    .command("create")
    .description("Create a new backup of all backup-enabled service volumes")
    .option("--name <name>", "Backup name (default: ISO timestamp)")
    .action(async (options: { name?: string }) => {
      try {
        await createBackup({ name: options.name });
      } catch (err) {
        log.err((err as Error).message);
        process.exit(1);
      }
    });

  backup
    .command("list")
    .description("List existing backups under infra/docker/backups/")
    .action(() => {
      const rows = listBackups();
      console.log(formatBackupsTable(rows));
    });

  backup
    .command("restore <name>")
    .description("Restore a previous backup")
    .option("--services <ids...>", "Restrict restore to a subset of service ids from the backup")
    .option("--stop-running", "Stop currently-running target services before restoring")
    .action(async (name: string, options: { services?: string[]; stopRunning?: boolean }) => {
      try {
        await restoreBackup({
          name,
          serviceIds: options.services,
          stopRunning: options.stopRunning,
        });
      } catch (err) {
        log.err((err as Error).message);
        process.exit(1);
      }
    });

  backup
    .command("prune")
    .description("Delete backups older than the configured retention period")
    .option("--retention-days <days>", "Retention period in days")
    .action((options: { retentionDays?: string }) => {
      try {
        const retentionDays =
          options.retentionDays === undefined
            ? configuredBackupRetentionDays()
            : Number(options.retentionDays);
        const result = pruneExpiredBackups({ retentionDays });
        log.ok(`Pruned ${result.deleted.length} expired backup(s)`);
      } catch (err) {
        log.err((err as Error).message);
        process.exit(1);
      }
    });

  backup
    .command("delete <name>")
    .description("Delete a backup directory")
    .action((name: string) => {
      try {
        deleteBackup({ name });
      } catch (err) {
        log.err((err as Error).message);
        process.exit(1);
      }
    });
}
