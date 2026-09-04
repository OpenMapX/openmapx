import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import {
  isPrivacyBackupCollectorImage,
  PRIVACY_BACKUP_MAX_OUTPUT_BYTES,
  type PrivacyBackupSubjectExportRequest,
} from "@openmapx/core/ops";
import {
  inspectBackupInventory,
  inspectPrivacyBackupLease,
  readVerifiedPrivacyBackupInputs,
} from "./administrative-runtime";
import type { TrustedPrivacyBackup } from "./privacy-backup-extraction";
import { PrivacyBackupExtractionError as BackupError } from "./privacy-backup-extraction";

const SAFE_BACKUP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SCRATCH_MARKER = "openmapx-privacy-backup-extraction-v1";
const SCRATCH_ROOT_RELATIVE = ["infra", "docker", "data", "privacy-extraction"] as const;
const DEPLOYMENT_SCRATCH_ROOT = "/var/lib/openmapx/privacy-extraction";
const COLLECTOR_ENTRYPOINT = "/usr/local/bin/openmapx-backup-subject-export";
const MAX_RUNTIME_SECONDS = 15 * 60;
const SCRATCH_RETENTION_MS = 2 * 60 * 60 * 1_000;

export interface PrivacyBackupRuntimeOptions {
  rootDir: string;
  collectorImage?: string;
  scratchRoot?: string;
  dockerBinary?: string;
  timeoutMs?: number;
  spawnImpl?: typeof import("node:child_process").spawn;
}

export interface PrivacyBackupRuntimeHealth {
  ready: boolean;
  inventoryReadable: boolean;
  collectorImage: string | null;
}

interface RuntimeChild {
  exitCode?: number | null;
  kill(signal?: NodeJS.Signals): boolean;
  killed: boolean;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  stdout?: Readable | null;
  stderr?: Readable | null;
  stdin?: { end(data?: string): void } | null;
}

function safeScratchRoot(options: PrivacyBackupRuntimeOptions): string {
  const root = options.scratchRoot ?? join(options.rootDir, ...SCRATCH_ROOT_RELATIVE);
  if (!isAbsolute(root) || root.includes("\0"))
    throw new Error("privacy extraction scratch root is invalid");
  return root;
}

function assertSafeDirectory(path: string): void {
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.nlink < 1 ||
    (uid !== undefined && stat.uid !== uid) ||
    (stat.mode & 0o777) !== 0o700
  ) {
    throw new Error("privacy extraction directory is unsafe");
  }
}

function assertScratchRootWithinRepository(rootDir: string, scratchRoot: string): void {
  const configured = relative(rootDir, scratchRoot);
  if (scratchRoot === DEPLOYMENT_SCRATCH_ROOT) return;
  if (
    !configured ||
    configured.startsWith(`..${sep}`) ||
    configured === ".." ||
    isAbsolute(configured)
  ) {
    throw new Error("privacy extraction scratch root is outside the repository");
  }
}

function createScratchDirectory(
  options: PrivacyBackupRuntimeOptions,
  request: PrivacyBackupSubjectExportRequest,
): { path: string; cleanup: () => void } {
  const root = safeScratchRoot(options);
  assertScratchRootWithinRepository(options.rootDir, root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    // The CLI creates this host directory before Compose starts. Refuse a
    // pre-existing root with a different owner or broader permissions rather
    // than allowing a container bind mount to redirect scratch data.
    const current = lstatSync(root);
    if (
      (current.mode & 0o777) !== 0o700 ||
      (process.getuid?.() !== undefined && current.uid !== process.getuid?.())
    ) {
      throw new Error("privacy extraction directory is unsafe");
    }
  } catch {
    throw new Error("privacy extraction directory is unsafe");
  }
  assertSafeDirectory(root);
  const path = mkdtempSync(join(root, "case-"));
  try {
    const stat = lstatSync(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.nlink < 1 ||
      (stat.mode & 0o777) !== 0o700 ||
      (process.getuid?.() !== undefined && stat.uid !== process.getuid?.())
    )
      throw new Error("privacy extraction directory is unsafe");
    const marker = {
      marker: SCRATCH_MARKER,
      requestId: request.requestId,
      backupId: request.backupId,
    };
    const markerPath = join(path, "marker.json");
    const descriptor = openSync(
      markerPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(descriptor, `${JSON.stringify(marker)}\n`, "utf8");
    } finally {
      closeSync(descriptor);
    }
    let cleaned = false;
    return {
      path,
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        try {
          assertSafeDirectory(root);
          const current = lstatSync(path);
          if (
            !current.isDirectory() ||
            current.isSymbolicLink() ||
            current.nlink < 1 ||
            (current.mode & 0o777) !== 0o700 ||
            (process.getuid?.() !== undefined && current.uid !== process.getuid?.())
          )
            return;
          // Refuse to remove an ambiguous directory. The marker is bounded and
          // checked before the exact case directory is removed.
          const markerContents = readFileSync(join(path, "marker.json"), "utf8");
          if (markerContents !== `${JSON.stringify(marker)}\n`) return;
          rmSync(path, { recursive: true, force: false });
        } catch {
          // Cleanup is retried by the startup janitor; never broaden this exact
          // target into a glob or parent-directory removal.
        }
      },
    };
  } catch (error) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      /* startup janitor will report it */
    }
    throw error;
  }
}

function fixedDockerArgs(
  options: PrivacyBackupRuntimeOptions,
  request: PrivacyBackupSubjectExportRequest,
): string[] {
  if (!SAFE_BACKUP_ID.test(request.backupId)) throw new BackupError("backup_unavailable");
  const image = options.collectorImage?.trim();
  if (!image || !isPrivacyBackupCollectorImage(image)) throw new BackupError("not_configured");
  const backupPath = join(options.rootDir, "infra", "docker", "backups", request.backupId);
  if (!backupPath.startsWith(`${options.rootDir}/infra/docker/backups/`))
    throw new BackupError("backup_unavailable");
  try {
    const stat = lstatSync(backupPath);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.nlink < 1)
      throw new Error("unsafe backup");
  } catch {
    throw new BackupError("backup_unavailable");
  }
  const name = `openmapx-privacy-${request.requestId.replace(/[^a-f0-9]/gi, "").slice(0, 32)}-${randomUUID().slice(0, 8)}`;
  return [
    "run",
    "--rm",
    "-i",
    "--init",
    "--name",
    name,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "256",
    "--memory",
    "1g",
    "--cpus",
    "1",
    "--label",
    `${SCRATCH_MARKER}=1`,
    "--label",
    `openmapx.privacy.request=${request.requestId}`,
    "--mount",
    `type=bind,src=${backupPath},dst=/input,readonly`,
    "--tmpfs",
    "/scratch:rw,noexec,nosuid,nodev,size=1073741824,mode=0700,uid=999,gid=999",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=67108864",
    "--entrypoint",
    COLLECTOR_ENTRYPOINT,
    image,
  ];
}

function spawnCollector(
  options: PrivacyBackupRuntimeOptions,
  args: readonly string[],
  input: string,
  signal: AbortSignal,
): Promise<Readable> {
  const spawnProcess = options.spawnImpl ?? nodeSpawn;
  const nameIndex = args.indexOf("--name");
  const containerName = nameIndex >= 0 ? args[nameIndex + 1] : undefined;
  const child = spawnProcess(options.dockerBinary ?? "docker", args, {
    stdio: ["pipe", "pipe", "pipe"],
  }) as RuntimeChild;
  if (!child.stdout || !child.stdin) throw new BackupError("collector_failed");
  const output = new PassThrough();
  let childClosed = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const clearForceKillTimer = () => {
    if (forceKillTimer !== undefined) {
      clearTimeout(forceKillTimer);
      forceKillTimer = undefined;
    }
  };
  const terminate = () => {
    if (childClosed || child.exitCode != null) return;
    if (!child.killed) child.kill("SIGTERM");
    if (containerName) {
      const remover = spawnProcess(options.dockerBinary ?? "docker", ["rm", "-f", containerName], {
        stdio: "ignore",
      });
      remover.once("error", () => undefined);
    }
    if (forceKillTimer === undefined) {
      forceKillTimer = setTimeout(() => {
        forceKillTimer = undefined;
        if (!childClosed && child.exitCode == null) child.kill("SIGKILL");
      }, 1_000);
    }
  };
  signal.addEventListener("abort", terminate, { once: true });
  child.stderr?.resume();
  // Do not end the response merely because stdout reached EOF. Docker may
  // still report a non-zero collector exit; only the child close status can
  // make the streamed result successful.
  child.stdout.pipe(output, { end: false });
  child.once("error", () => output.destroy(new BackupError("collector_failed")));
  child.once("close", (code: unknown, _sig: unknown) => {
    childClosed = true;
    clearForceKillTimer();
    signal.removeEventListener("abort", terminate);
    if (code !== 0 && !output.destroyed) output.destroy(new BackupError("collector_failed"));
    else if (!output.destroyed && !output.readableEnded) output.end();
  });
  output.once("close", terminate);
  child.stdin.end(`${input}\n`);
  return Promise.resolve(output);
}

/**
 * Wire the production backup collector. The image is intentionally supplied
 * only as a digest-pinned deployment setting: an unpinned or absent collector
 * is unavailable, never silently treated as a complete source.
 */
export function createPrivacyBackupExtractionRuntime(options: PrivacyBackupRuntimeOptions) {
  const timeoutMs = options.timeoutMs ?? MAX_RUNTIME_SECONDS * 1_000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    timeoutMs > MAX_RUNTIME_SECONDS * 1_000
  )
    throw new Error("invalid privacy backup runtime timeout");
  return {
    enabled: Boolean(
      options.collectorImage && isPrivacyBackupCollectorImage(options.collectorImage),
    ),
    inspectBackup: async (
      request: PrivacyBackupSubjectExportRequest,
      signal: AbortSignal,
    ): Promise<TrustedPrivacyBackup> => {
      try {
        return await inspectPrivacyBackupLease(
          options.rootDir,
          request.backupId,
          request.manifestDigest,
          signal,
        );
      } catch {
        throw new BackupError("backup_unavailable");
      }
    },
    runCollector: async (
      request: PrivacyBackupSubjectExportRequest,
      _backup: TrustedPrivacyBackup,
      signal: AbortSignal,
    ): Promise<Readable> => {
      if (signal.aborted) throw new BackupError("timeout");
      // Re-read the manifest while the lease is held. This is deliberately
      // internal: the validated filenames are only converted into fixed Docker
      // mounts, never sent back through the API contract.
      let verified: ReturnType<typeof readVerifiedPrivacyBackupInputs>;
      try {
        verified = readVerifiedPrivacyBackupInputs(
          options.rootDir,
          request.backupId,
          request.manifestDigest,
        );
      } catch {
        throw new BackupError("backup_digest_changed");
      }
      const sources = verified.inputs
        .filter(
          (input) =>
            (input.mode === "pg_dump" &&
              (input.serviceId === "postgis" || input.serviceId === "dawarich-postgis")) ||
            (input.mode === "tar" &&
              input.serviceId === "dawarich-app" &&
              input.volumeId === "openmapx-dawarich-storage"),
        )
        .map((input) => ({
          family:
            input.serviceId === "postgis"
              ? "openmapx"
              : input.serviceId === "dawarich-postgis"
                ? "dawarich"
                : "dawarich-storage",
          serviceId: input.serviceId,
          file: input.file,
          schemaContract:
            input.serviceId === "postgis"
              ? "openmapx-v1"
              : input.serviceId === "dawarich-app"
                ? "dawarich-storage-1.10.3"
                : verified.manifest.privacySourceProvenance?.managedDawarich?.schemaContract,
        }));
      if (sources.length < 1 || sources.some((source) => !source.schemaContract))
        throw new BackupError("unsupported_collector");
      const scratch = createScratchDirectory(options, request);
      try {
        const args = fixedDockerArgs(options, request);
        const source = await spawnCollector(
          options,
          args,
          JSON.stringify({
            version: 1,
            requestId: request.requestId,
            backupId: request.backupId,
            manifestDigest: request.manifestDigest,
            cutoff: request.cutoff,
            subjectLocator: request.subjectLocator,
            collectorContract: request.collectorContract,
            sources,
          }),
          signal,
        );
        const timer = setTimeout(() => source.destroy(new BackupError("timeout")), timeoutMs);
        source.once("close", () => {
          clearTimeout(timer);
          scratch.cleanup();
        });
        return source;
      } catch (error) {
        scratch.cleanup();
        throw error;
      }
    },
  };
}

async function collectorImagePresent(options: PrivacyBackupRuntimeOptions): Promise<boolean> {
  const image = options.collectorImage?.trim();
  if (!image || !isPrivacyBackupCollectorImage(image)) return false;
  const spawn = options.spawnImpl ?? nodeSpawn;
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(options.dockerBinary ?? "docker", ["image", "inspect", image], {
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, 5_000);
    child.once("error", () => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve(false);
      }
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve(code === 0);
      }
    });
  });
}

/** Live release evidence: the exact digest-pinned image must be locally
 * inspectable and the descriptor-backed inventory root must be readable. */
export async function probePrivacyBackupRuntime(
  options: PrivacyBackupRuntimeOptions & { enabled: boolean },
): Promise<PrivacyBackupRuntimeHealth> {
  const collectorImage = options.collectorImage?.trim() || null;
  let inventoryReadable = false;
  try {
    const root = join(options.rootDir, "infra", "docker", "backups");
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe backup root");
    accessSync(root, constants.R_OK | constants.X_OK);
    inspectBackupInventory(options.rootDir);
    inventoryReadable = true;
  } catch {
    inventoryReadable = false;
  }
  const imagePresent = options.enabled && (await collectorImagePresent(options));
  return {
    ready: imagePresent && inventoryReadable,
    inventoryReadable,
    collectorImage,
  };
}

export function privacyBackupScratchRoot(rootDir: string, scratchRoot?: string): string {
  return scratchRoot?.trim() || join(rootDir, ...SCRATCH_ROOT_RELATIVE);
}

/** Remove only stale directories that prove ownership with the fixed marker.
 * Ambiguous, malformed or recently-created entries are left for an operator;
 * the janitor never recursively deletes an arbitrary child of the root. */
export function janitorPrivacyBackupScratch(
  rootDir: string,
  scratchRoot?: string,
  now = Date.now(),
): { removed: number; retained: number } {
  const root = privacyBackupScratchRoot(rootDir, scratchRoot);
  try {
    assertScratchRootWithinRepository(rootDir, root);
  } catch {
    return { removed: 0, retained: 0 };
  }
  try {
    assertSafeDirectory(root);
  } catch {
    return { removed: 0, retained: 0 };
  }
  let entries: Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>;
  try {
    entries = readdirSync(root, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return { removed: 0, retained: 0 };
  }
  let removed = 0;
  let retained = 0;
  for (const entry of entries.slice(0, 256)) {
    if (!entry.name.startsWith("case-") || !entry.isDirectory() || entry.isSymbolicLink()) {
      retained += 1;
      continue;
    }
    const path = join(root, entry.name);
    try {
      const stat = lstatSync(path);
      const marker = JSON.parse(readFileSync(join(path, "marker.json"), "utf8")) as Record<
        string,
        unknown
      >;
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.nlink < 1 ||
        (stat.mode & 0o777) !== 0o700 ||
        (process.getuid?.() !== undefined && stat.uid !== process.getuid?.()) ||
        marker.marker !== SCRATCH_MARKER ||
        typeof marker.requestId !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(marker.requestId) ||
        typeof marker.backupId !== "string" ||
        !SAFE_BACKUP_ID.test(marker.backupId) ||
        now - stat.mtimeMs < SCRATCH_RETENTION_MS
      ) {
        retained += 1;
        continue;
      }
      rmSync(path, { recursive: true, force: false });
      removed += 1;
    } catch {
      retained += 1;
    }
  }
  if (entries.length > 256) retained += entries.length - 256;
  return { removed, retained };
}

export const PRIVACY_BACKUP_RUNTIME_MAX_OUTPUT_BYTES = PRIVACY_BACKUP_MAX_OUTPUT_BYTES;
