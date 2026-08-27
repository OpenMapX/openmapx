import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { services as coreServices, repoPaths } from "@openmapx/core/server";

const {
  DEFAULT_SELECTED_SERVICE_IDS,
  expandServiceSelection,
  normalizeServiceIds,
  parseServiceIdList,
  SERVICE_SELECTION_ENV,
} = coreServices;

const SERVICE_SELECTION_FILE = "service-selection.json";
// Leading char must be alphanumeric: this rejects "." / ".." (path traversal
// when the name is joined into the backups directory) and leading-dash names
// (argument-injection-shaped when forwarded as a CLI argv element). Mirrors the
// slug guard used for other CLI arguments in admin-job-handlers.ts.
const BACKUP_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

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

function trustedSelectionFilePath(rootDir?: string): string | null {
  const infraDir = repoPaths(rootDir).infraDir;
  const current = join(infraDir, ".trusted-config-current");
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(current);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stats.isSymbolicLink()) throw new Error("Malformed trusted service selection pointer");
  const target = readlinkSync(current);
  if (!/^\.trusted-config-generations\/cfg1_[A-Za-z0-9_-]{43}$/.test(target)) {
    throw new Error("Malformed trusted service selection pointer");
  }
  const absolute = resolve(infraDir, target);
  if (!absolute.startsWith(`${resolve(infraDir, ".trusted-config-generations")}/`)) {
    throw new Error("Malformed trusted service selection pointer");
  }
  return join(current, SERVICE_SELECTION_FILE);
}

function selectionFilePath(rootDir?: string): string {
  return (
    trustedSelectionFilePath(rootDir) ?? join(repoPaths(rootDir).infraDir, SERVICE_SELECTION_FILE)
  );
}

function readSelectionFile(rootDir?: string): string[] | null {
  const trusted = trustedSelectionFilePath(rootDir);
  const path = selectionFilePath(rootDir);
  if (!existsSync(path)) {
    if (trusted) throw new Error("Malformed trusted service selection");
    return null;
  }
  const raw = JSON.parse(readFileSync(path, "utf-8")) as { selected?: unknown };
  if (!Array.isArray(raw.selected)) {
    throw new Error(`Malformed service selection file at ${path}: expected "selected" array`);
  }
  return normalizeServiceIds(raw.selected);
}

export function getServiceSelectionSummary(
  registry: InstanceType<typeof coreServices.ServiceRegistry>,
  rootDir?: string,
  authoritativeRoots?: string[],
): ServiceSelectionSummary {
  const trustedCurrentExists = trustedSelectionFilePath(rootDir) !== null;
  const envSelection = parseServiceIdList(process.env[SERVICE_SELECTION_ENV]);
  const fileSelection =
    authoritativeRoots ??
    (trustedCurrentExists || envSelection === null ? readSelectionFile(rootDir) : null);
  const source: ServiceSelectionSummary["source"] =
    authoritativeRoots !== undefined
      ? "file"
      : trustedCurrentExists
        ? "file"
        : envSelection !== null
          ? "env"
          : fileSelection !== null
            ? "file"
            : "default";
  const selectedRoots = authoritativeRoots ??
    (trustedCurrentExists ? fileSelection : (envSelection ?? fileSelection)) ?? [
      ...DEFAULT_SELECTED_SERVICE_IDS,
    ];
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
  options: { allowBakedEnvironment?: boolean } = {},
): { normalized: string[]; warnings: string[]; missingIds: string[] } {
  if (
    !options.allowBakedEnvironment &&
    parseServiceIdList(process.env[SERVICE_SELECTION_ENV]) !== null
  ) {
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

export function assertValidBackupName(name: string): void {
  if (name.length > 128 || !BACKUP_NAME_RE.test(name)) {
    throw new Error(`Invalid backup name "${name}"`);
  }
}
