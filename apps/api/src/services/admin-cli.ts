import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { services as coreServices, findRepoRoot, repoPaths } from "@openmapx/core/server";
import type { JobContext } from "./job-runner";

const {
  DEFAULT_SELECTED_SERVICE_IDS,
  expandServiceSelection,
  normalizeServiceIds,
  parseServiceIdList,
  SERVICE_SELECTION_ENV,
} = coreServices;

const SERVICE_SELECTION_FILE = "service-selection.json";
const BACKUPS_DIR = "backups";
const BACKUP_NAME_RE = /^[a-zA-Z0-9._-]+$/;

export interface ServiceSelectionSummary {
  source: "env" | "file" | "default";
  selectedRoots: string[];
  requestedIds: string[];
  effectiveIds: string[];
  warnings: string[];
  missingIds: string[];
  envVarName: string;
  envVarValue: string | null;
  selectionFilePath: string;
}

export interface ListedBackupSummary {
  name: string;
  createdAt: string;
  openmapxVersion?: string;
  services: number;
  volumes: number;
  totalBytes: number;
}

interface BackupManifest {
  name: string;
  createdAt: string;
  openmapxVersion?: string;
  services: Array<{
    id: string;
    volumes: Array<{ name: string; file: string; mode: "tar" | "pg_dump"; sizeBytes: number }>;
  }>;
}

function selectionFilePath(rootDir?: string): string {
  return join(repoPaths(rootDir).infraDir, SERVICE_SELECTION_FILE);
}

function readSelectionFile(rootDir?: string): string[] | null {
  const path = selectionFilePath(rootDir);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf-8")) as { selected?: unknown };
  if (!Array.isArray(raw.selected)) {
    throw new Error(`Malformed service selection file at ${path}: expected "selected" array`);
  }
  return normalizeServiceIds(raw.selected);
}

export function getServiceSelectionSummary(
  registry: InstanceType<typeof coreServices.ServiceRegistry>,
  rootDir?: string,
): ServiceSelectionSummary {
  const envSelection = parseServiceIdList(process.env[SERVICE_SELECTION_ENV]);
  const fileSelection = envSelection === null ? readSelectionFile(rootDir) : null;
  const source: ServiceSelectionSummary["source"] =
    envSelection !== null ? "env" : fileSelection !== null ? "file" : "default";
  const selectedRoots = envSelection ?? fileSelection ?? [...DEFAULT_SELECTED_SERVICE_IDS];
  const selection = expandServiceSelection(registry.list(), selectedRoots, {
    allowMissingSelected: source === "default",
  });
  return {
    source,
    selectedRoots,
    requestedIds: selection.requestedIds,
    effectiveIds: selection.enabledIdsOrdered,
    warnings: selection.warnings,
    missingIds: selection.missingIds,
    envVarName: SERVICE_SELECTION_ENV,
    envVarValue: process.env[SERVICE_SELECTION_ENV] ?? null,
    selectionFilePath: selectionFilePath(rootDir),
  };
}

export function validateServiceSelectionForWrite(
  registry: InstanceType<typeof coreServices.ServiceRegistry>,
  selected: string[],
): { normalized: string[]; warnings: string[]; missingIds: string[] } {
  if (parseServiceIdList(process.env[SERVICE_SELECTION_ENV]) !== null) {
    throw new Error(
      `${SERVICE_SELECTION_ENV} is set; unset it before editing ${SERVICE_SELECTION_FILE}`,
    );
  }
  const normalized = normalizeServiceIds(selected);
  const selection = expandServiceSelection(registry.list(), normalized, {
    allowMissingSelected: false,
  });
  if (selection.missingIds.length > 0) {
    throw new Error(`Selected service(s) are not installed: ${selection.missingIds.join(", ")}`);
  }
  return { normalized, warnings: selection.warnings, missingIds: selection.missingIds };
}

export function writeServiceSelection(normalizedSelected: string[], rootDir?: string): string {
  const path = selectionFilePath(rootDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ selected: normalizedSelected }, null, 2), "utf-8");
  return path;
}

function backupsRoot(rootDir?: string): string {
  return join(repoPaths(rootDir).infraDir, BACKUPS_DIR);
}

function readBackupManifest(path: string): BackupManifest {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<BackupManifest>;
  if (
    !raw ||
    typeof raw.name !== "string" ||
    typeof raw.createdAt !== "string" ||
    !Array.isArray(raw.services)
  ) {
    throw new Error(`Malformed backup manifest at ${path}`);
  }
  return raw as BackupManifest;
}

export function listBackupSummaries(rootDir?: string): {
  backups: ListedBackupSummary[];
  warnings: string[];
  root: string;
} {
  const root = backupsRoot(rootDir);
  const warnings: string[] = [];
  if (!existsSync(root)) return { backups: [], warnings, root };

  const backups: ListedBackupSummary[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(root, entry.name, "manifest.json");
    if (!existsSync(manifestPath)) {
      warnings.push(`skipping ${entry.name}: no manifest.json`);
      continue;
    }
    try {
      const manifest = readBackupManifest(manifestPath);
      const volumes = manifest.services.reduce((n, svc) => n + svc.volumes.length, 0);
      const totalBytes = manifest.services
        .flatMap((svc) => svc.volumes.map((vol) => vol.sizeBytes ?? 0))
        .reduce((a, b) => a + b, 0);
      backups.push({
        name: entry.name,
        createdAt: manifest.createdAt,
        openmapxVersion: manifest.openmapxVersion,
        services: manifest.services.length,
        volumes,
        totalBytes,
      });
    } catch (err) {
      warnings.push(`skipping ${entry.name}: ${(err as Error).message}`);
    }
  }

  backups.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { backups, warnings, root };
}

export function assertValidBackupName(name: string): void {
  if (!BACKUP_NAME_RE.test(name)) {
    throw new Error(`Invalid backup name "${name}"`);
  }
}

/**
 * Spawn the OpenMapX CLI from the monorepo and mirror output into job logs.
 * This keeps admin operations behaviour aligned with existing CLI workflows.
 */
export async function runOpenmapxCliJobCommand(ctx: JobContext, args: string[]): Promise<void> {
  const rootDir = findRepoRoot();
  const cliEntry = join(rootDir, "packages", "cli", "src", "index.ts");
  if (!existsSync(cliEntry)) {
    throw new Error(`CLI entry not found at ${cliEntry}`);
  }

  await ctx.log(`$ openmapx ${args.join(" ")}`);

  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", cliEntry, ...args],
    {
      cwd: rootDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let logChain: Promise<void> = Promise.resolve();
  const enqueueLog = (line: string, stream: "stdout" | "stderr") => {
    if (!line.trim()) return;
    logChain = logChain.then(() => ctx.log(line, stream));
  };

  const stdout = createInterface({ input: child.stdout });
  const stderr = createInterface({ input: child.stderr });
  stdout.on("line", (line) => enqueueLog(line, "stdout"));
  stderr.on("line", (line) => enqueueLog(line, "stderr"));

  const abortController = () => {
    if (!child.killed) child.kill("SIGTERM");
  };
  ctx.signal.addEventListener("abort", abortController, { once: true });

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal }));
    },
  ).finally(() => {
    ctx.signal.removeEventListener("abort", abortController);
  });

  stdout.close();
  stderr.close();
  await logChain;

  if (ctx.signal.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  if (result.code !== 0) {
    throw new Error(
      `openmapx ${args.join(" ")} failed (exit ${result.code ?? "?"}${result.signal ? `, signal ${result.signal}` : ""})`,
    );
  }
}
