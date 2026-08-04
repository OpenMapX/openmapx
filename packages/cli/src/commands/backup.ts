import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { services as coreServices } from "@openmapx/core/server";
import { PLATFORM_VERSION } from "@openmapx/integration-framework";
import type { Command } from "commander";
import { execa } from "execa";
import kleur from "kleur";
import { log, table } from "../lib/output";
import { repoPaths } from "../lib/paths";
import { applyServiceSelection } from "../lib/service-selection";

const { ServiceRegistry } = coreServices;

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
  volumes: BackupVolumeEntry[];
}

export interface BackupManifest {
  name: string;
  createdAt: string;
  openmapxVersion?: string;
  services: BackupServiceEntry[];
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

// A leading dash would make dropdb/createdb/psql interpret the value as a flag.
const PG_IDENT_REGEX = /^[a-zA-Z_][a-zA-Z0-9_$]*$/;

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
  if (typeof entry.name !== "string" || entry.name.length === 0) {
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
    entry.resolvedName !== undefined &&
    (typeof entry.resolvedName !== "string" || !VOLUME_NAME_REGEX.test(entry.resolvedName))
  ) {
    throw new Error(`Invalid docker volume name in ${context}`);
  }
  if (
    entry.postgresUser !== undefined &&
    (typeof entry.postgresUser !== "string" || !PG_IDENT_REGEX.test(entry.postgresUser))
  ) {
    throw new Error(`Invalid postgres user in ${context}`);
  }
  if (
    entry.postgresDb !== undefined &&
    (typeof entry.postgresDb !== "string" || !PG_IDENT_REGEX.test(entry.postgresDb))
  ) {
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
  if (!existsSync(filePath)) {
    throw new Error(`Backup manifest not found: ${filePath}`);
  }
  const raw = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<BackupManifest>;
  if (
    !raw ||
    typeof raw.name !== "string" ||
    typeof raw.createdAt !== "string" ||
    !Array.isArray(raw.services)
  ) {
    throw new Error(`Malformed backup manifest at ${filePath}`);
  }
  for (const s of raw.services) {
    if (typeof s.id !== "string" || !Array.isArray(s.volumes)) {
      throw new Error(`Malformed service entry in ${filePath}`);
    }
    if (!SERVICE_ID_REGEX.test(s.id)) {
      throw new Error(`Invalid service id in ${filePath}: ${s.id}`);
    }
    for (const volume of s.volumes) {
      assertValidVolumeEntry(volume, filePath);
    }
  }
  return raw as BackupManifest;
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
}

export interface BackupableService {
  id: string;
  isPostgres: boolean;
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
    out.push({
      id: svc.manifest.id,
      isPostgres: svc.manifest.id === "postgis",
      postgresUser: env.POSTGRES_USER,
      postgresDb: env.POSTGRES_DB,
      volumes: backupVolumes.map((v) => ({
        serviceId: svc.manifest.id,
        volumeName: v.name,
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
    if (svc.isPostgres) continue;
    for (const v of svc.volumes) declaredNames.push(v.volumeName);
  }
  const volumeNames = await resolveVolumeNames(ctx, declaredNames);

  mkdirSync(backupDir, { recursive: true });

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
    name,
    createdAt: new Date().toISOString(),
    openmapxVersion: PLATFORM_VERSION,
    services: [],
  };

  try {
    for (const svc of targets) {
      log.info(kleur.bold(`◆ ${svc.id}`));
      const serviceEntry: BackupServiceEntry = { id: svc.id, volumes: [] };

      for (const v of svc.volumes) {
        if (svc.isPostgres) {
          // Postgres: pg_dump while running. One dump file per declared volume
          // keeps the manifest schema simple even though the volume is just a
          // marker for "this service has data to back up".
          const file = `${svc.id}__${v.volumeName}.sql.gz`;
          const out = join(backupDir, file);
          const user = svc.postgresUser ?? "postgres";
          const db = svc.postgresDb ?? "openmapx";
          log.dim(`  pg_dump ${db} (user=${user}) → ${file}`);
          await pgDumpToFile(ctx, svc.id, user, db, out);
          serviceEntry.volumes.push({
            name: v.volumeName,
            mode: "pg_dump",
            file,
            sizeBytes: safeSize(out),
            // Persist the credentials so restore can target the same
            // database/user even if the manifest changes later.
            postgresUser: user,
            postgresDb: db,
          });
        } else {
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
          });
        }
      }

      manifest.services.push(serviceEntry);
    }

    writeFileSync(
      join(backupDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf-8",
    );

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

  const out = createWriteStream(outFile);
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

  let versionError: string | undefined;
  let versionWarning: string | undefined;
  if (manifest.openmapxVersion) {
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

  const ctx = ctxFromRepo(opts.rootDir);
  const targetIds = pre.targets.map((s) => s.id);

  const running = await listRunningServices(ctx);
  const runningTargets = targetIds.filter((id) => running.has(id));
  if (runningTargets.length > 0 && !opts.stopRunning) {
    throw new Error(
      `Refusing to restore — these target services are running: ${runningTargets.join(
        ", ",
      )}. Pass --stop-running to stop them automatically.`,
    );
  }

  const stopped: string[] = [];
  try {
    // Stop running targets up-front (postgres handled separately below — we
    // do NOT stop it because we're restoring via dropdb/createdb/psql, which
    // requires the server to be up).
    for (const id of runningTargets) {
      const isPg = id === "postgis";
      if (isPg) continue;
      log.dim(`stopping ${id}…`);
      await dockerCompose(ctx, ["stop", id]);
      stopped.push(id);
    }

    for (const svc of pre.targets) {
      log.info(kleur.bold(`◆ ${svc.id}`));
      for (const vol of svc.volumes) {
        // Defense-in-depth backstop for the filename validation in readBackupManifest.
        const file = resolve(pre.backupDir, vol.file);
        if (!file.startsWith(`${resolve(pre.backupDir)}/`)) {
          throw new Error(`Refusing to read a backup file outside ${pre.backupDir}: ${file}`);
        }
        if (!existsSync(file)) {
          throw new Error(`Backup file missing: ${file}`);
        }

        if (vol.mode === "pg_dump") {
          // Postgres needs to be running for psql.
          if (!running.has(svc.id)) {
            log.dim(`  starting ${svc.id} for restore…`);
            await dockerCompose(ctx, ["start", svc.id]);
          }
          // Credentials persisted at backup time.
          if (!vol.postgresUser || !vol.postgresDb) {
            throw new Error(
              `Backup entry ${vol.name} is missing postgres credentials — re-create the backup.`,
            );
          }
          const user = vol.postgresUser;
          const db = vol.postgresDb;
          log.dim(`  restoring database ${db} (user=${user}) from ${vol.file}…`);
          await pgRestoreFromFile(ctx, svc.id, file, user, db);
        } else {
          if (!vol.resolvedName) {
            throw new Error(
              `Backup entry ${vol.name} is missing its resolved docker volume name — re-create the backup.`,
            );
          }
          log.dim(`  restoring volume ${vol.resolvedName} from ${vol.file}…`);
          await tarRestoreFromFile(vol.resolvedName, pre.backupDir, vol.file);
        }
      }
    }

    // Restart everything we stopped.
    for (const id of [...stopped].reverse()) {
      log.dim(`  starting ${id}…`);
      await dockerCompose(ctx, ["start", id]);
    }

    const volCount = pre.targets.reduce((n, s) => n + s.volumes.length, 0);
    log.ok(
      `Restore of ${kleur.bold(opts.name)} complete — ${pre.targets.length} services, ${volCount} volumes`,
    );
  } catch (err) {
    log.err(`Restore failed: ${(err as Error).message}`);
    // Best-effort restart of everything we stopped, even on failure.
    for (const id of [...stopped].reverse()) {
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
  rmSync(backupDir, { recursive: true, force: true });
  log.ok(`Deleted backup ${kleur.bold(opts.name)}`);
}

// ─── Command registration ──────────────────────────────────────────────────

export function registerBackupCommands(program: Command): void {
  const backup = program
    .command("backup")
    .description("Create, list, restore, and delete on-disk backups of service volumes");

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
