import {
  type Dirent,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { services as coreServices } from "@openmapx/core/server";
import { repoPaths } from "./paths";

const { ServiceRegistry } = coreServices;

const DATA_DIR_PREFIX = "data/";
const DATA_MANAGER_STATE_FILENAME = ".data-manager-state.json";
const CONTAINER_DATA_ROOT = "/data";
const CONTAINER_DATA_PREFIX = "/data/";

const CLEAN_TYPE_ALIASES: Record<string, string[]> = {
  osm: ["osm-pbf"],
  "osm-bz2": ["osm-pbf-bz2"],
  overpass: ["osm-pbf-bz2"],
  style: ["tile-fonts", "tile-styles"],
  styles: ["tile-fonts", "tile-styles"],
  fonts: ["tile-fonts"],
  mbtiles: ["tile-mbtiles"],
  tiles: ["tile-mbtiles", "tile-fonts", "tile-styles"],
};

export interface OfflineDataFile {
  name: string;
  path: string;
  sizeBytes: number;
}

export interface DirectoryUsage {
  name: string;
  path: string;
  files: number;
  sizeBytes: number;
}

export interface OfflineDataStatus {
  dataRoot: string;
  osmPbfFiles: OfflineDataFile[];
  gtfsZipFiles: OfflineDataFile[];
  directories: DirectoryUsage[];
  totalFiles: number;
  totalBytes: number;
}

export interface DataCleanupPlan {
  all: boolean;
  target: string;
  normalizedTypes: string[];
  availableTypes: string[];
  dataRoot: string;
  paths: string[];
}

export interface DataCleanupResult {
  removedPaths: number;
  removedFiles: number;
  removedBytes: number;
}

export interface DataManagerStatePruneResult {
  statePath: string;
  removedDatasets: number;
  remainingDatasets: number;
  updated: boolean;
}

interface PersistedDatasetEntry {
  type?: string;
  path?: string;
}

interface PersistedDataManagerState {
  datasets?: PersistedDatasetEntry[];
  [key: string]: unknown;
}

interface FileTreeSummary {
  files: number;
  sizeBytes: number;
}

function stripDataPrefix(path: string): string {
  if (path === "data" || path === "data/") return "";
  if (path.startsWith(DATA_DIR_PREFIX)) return path.slice(DATA_DIR_PREFIX.length);
  return path;
}

function ensureInsideDataRoot(dataRoot: string, path: string): string | null {
  const absRoot = resolve(dataRoot);
  const absPath = resolve(path);
  const rel = relative(absRoot, absPath);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return absPath;
  }
  return null;
}

function isWithinPath(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function toHostDataPath(dataRoot: string, inputPath: string | undefined): string | null {
  const path = inputPath?.trim();
  if (!path) return null;

  if (path === CONTAINER_DATA_ROOT) {
    return ensureInsideDataRoot(dataRoot, dataRoot);
  }
  if (path.startsWith(CONTAINER_DATA_PREFIX)) {
    return ensureInsideDataRoot(dataRoot, join(dataRoot, path.slice(CONTAINER_DATA_PREFIX.length)));
  }

  const stripped = stripDataPrefix(path);
  const candidate = isAbsolute(stripped) ? stripped : resolve(dataRoot, stripped);
  return ensureInsideDataRoot(dataRoot, candidate);
}

function listMatchingFiles(dir: string, predicate: (name: string) => boolean): OfflineDataFile[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => {
      const path = join(dir, entry.name);
      return {
        name: entry.name,
        path,
        sizeBytes: statSync(path).size,
      };
    });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

function summarizeDirent(parent: string, entry: Dirent): FileTreeSummary {
  const path = join(parent, entry.name);
  if (entry.isFile()) {
    return { files: 1, sizeBytes: statSync(path).size };
  }
  if (entry.isDirectory()) {
    return summarizePath(path);
  }
  return { files: 0, sizeBytes: 0 };
}

export function summarizePath(path: string): FileTreeSummary {
  if (!existsSync(path)) return { files: 0, sizeBytes: 0 };
  const stat = statSync(path);
  if (stat.isFile()) return { files: 1, sizeBytes: stat.size };
  if (!stat.isDirectory()) return { files: 0, sizeBytes: 0 };

  let files = 0;
  let sizeBytes = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const sub = summarizeDirent(path, entry);
    files += sub.files;
    sizeBytes += sub.sizeBytes;
  }
  return { files, sizeBytes };
}

export function collectOfflineDataStatus(rootDir?: string): OfflineDataStatus {
  const paths = repoPaths(rootDir);
  const dataRoot = join(paths.infraDir, "data");
  const osmPbfFiles = listMatchingFiles(join(dataRoot, "osm"), (name) => name.endsWith(".osm.pbf"));
  const gtfsZipFiles = listMatchingFiles(join(dataRoot, "gtfs"), (name) => name.endsWith(".zip"));

  const directories: DirectoryUsage[] = [];
  if (existsSync(dataRoot)) {
    for (const entry of readdirSync(dataRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(dataRoot, entry.name);
      const summary = summarizePath(path);
      directories.push({
        name: entry.name,
        path,
        files: summary.files,
        sizeBytes: summary.sizeBytes,
      });
    }
  }
  directories.sort((a, b) => a.name.localeCompare(b.name));

  const total = summarizePath(dataRoot);

  return {
    dataRoot,
    osmPbfFiles,
    gtfsZipFiles,
    directories,
    totalFiles: total.files,
    totalBytes: total.sizeBytes,
  };
}

async function loadDataTypes(rootDir?: string): Promise<{
  dataRoot: string;
  services: coreServices.LoadedService[];
  availableTypes: string[];
}> {
  const paths = repoPaths(rootDir);
  const registry = new ServiceRegistry({ rootDir: paths.root });
  await registry.load();

  const typeSet = new Set<string>();
  const list = registry.list();
  for (const svc of list) {
    for (const p of svc.manifest.produces ?? []) typeSet.add(p.type);
    for (const c of svc.manifest.consumes ?? []) typeSet.add(c.type);
  }

  return {
    dataRoot: join(paths.infraDir, "data"),
    services: list,
    availableTypes: [...typeSet].sort((a, b) => a.localeCompare(b)),
  };
}

function normalizeCleanupTypes(target: string, availableTypes: string[]): string[] {
  const normalized = target.trim().toLowerCase();
  if (!normalized) {
    throw new Error("cleanup target is required (use a data type name or 'all')");
  }
  if (normalized === "all") return [];

  const direct = availableTypes.includes(normalized) ? [normalized] : [];
  const fromAlias = CLEAN_TYPE_ALIASES[normalized] ?? [];
  const resolved =
    direct.length > 0 ? direct : fromAlias.filter((type) => availableTypes.includes(type));

  if (resolved.length > 0) {
    return [...new Set(resolved)];
  }

  const aliasNames = Object.keys(CLEAN_TYPE_ALIASES).sort((a, b) => a.localeCompare(b));
  throw new Error(
    `Unknown clean target: ${target}. Use one of: ${availableTypes.join(", ")}, ${aliasNames.join(", ")}, or all`,
  );
}

function producerPath(dataRoot: string, sourceDir: string): string | null {
  const candidate = isAbsolute(sourceDir)
    ? sourceDir
    : resolve(dataRoot, stripDataPrefix(sourceDir));
  return ensureInsideDataRoot(dataRoot, candidate);
}

export async function planDataCleanup(target: string, rootDir?: string): Promise<DataCleanupPlan> {
  const normalizedTarget = target.trim().toLowerCase();
  const { dataRoot, services, availableTypes } = await loadDataTypes(rootDir);

  if (normalizedTarget === "all") {
    return {
      all: true,
      target,
      normalizedTypes: [],
      availableTypes,
      dataRoot,
      paths: [resolve(dataRoot)],
    };
  }

  const normalizedTypes = normalizeCleanupTypes(target, availableTypes);
  const typeSet = new Set(normalizedTypes);
  const pathSet = new Set<string>();

  for (const svc of services) {
    for (const produces of svc.manifest.produces ?? []) {
      if (!typeSet.has(produces.type)) continue;
      const path = producerPath(dataRoot, produces.sourceDir);
      if (path) pathSet.add(path);
    }

    for (const consumes of svc.manifest.consumes ?? []) {
      if (!typeSet.has(consumes.type)) continue;
      const path = ensureInsideDataRoot(
        dataRoot,
        consumes.instance
          ? join(dataRoot, svc.manifest.id, consumes.type, consumes.instance)
          : join(dataRoot, svc.manifest.id, consumes.type),
      );
      if (path) pathSet.add(path);
    }
  }

  return {
    all: false,
    target,
    normalizedTypes,
    availableTypes,
    dataRoot,
    paths: [...pathSet].sort((a, b) => a.localeCompare(b)),
  };
}

export function applyDataCleanup(paths: string[]): DataCleanupResult {
  let removedPaths = 0;
  let removedFiles = 0;
  let removedBytes = 0;

  for (const path of paths) {
    if (!existsSync(path)) continue;
    const summary = summarizePath(path);
    rmSync(path, { recursive: true, force: true });
    removedPaths += 1;
    removedFiles += summary.files;
    removedBytes += summary.sizeBytes;
  }

  return {
    removedPaths,
    removedFiles,
    removedBytes,
  };
}

export function pruneDataManagerStateForCleanup(
  plan: DataCleanupPlan,
): DataManagerStatePruneResult {
  const statePath = join(plan.dataRoot, DATA_MANAGER_STATE_FILENAME);
  if (!existsSync(statePath)) {
    return {
      statePath,
      removedDatasets: 0,
      remainingDatasets: 0,
      updated: false,
    };
  }

  let parsed: PersistedDataManagerState;
  try {
    parsed = JSON.parse(readFileSync(statePath, "utf-8")) as PersistedDataManagerState;
  } catch {
    return {
      statePath,
      removedDatasets: 0,
      remainingDatasets: 0,
      updated: false,
    };
  }
  const currentDatasets = Array.isArray(parsed.datasets) ? parsed.datasets : [];
  const normalizedTargets = plan.paths.map((path) => resolve(path));
  const typeSet = new Set(plan.normalizedTypes);

  let removedDatasets = 0;
  const kept = currentDatasets.filter((entry) => {
    if (plan.all) {
      removedDatasets += 1;
      return false;
    }

    if (!entry.type || !typeSet.has(entry.type)) return true;
    const hostPath = toHostDataPath(plan.dataRoot, entry.path);
    if (!hostPath) return true;

    const shouldRemove = normalizedTargets.some((target) => isWithinPath(target, hostPath));
    if (shouldRemove) {
      removedDatasets += 1;
      return false;
    }
    return true;
  });

  if (removedDatasets === 0) {
    return {
      statePath,
      removedDatasets: 0,
      remainingDatasets: currentDatasets.length,
      updated: false,
    };
  }

  writeFileSync(statePath, JSON.stringify({ ...parsed, datasets: kept }, null, 2), "utf-8");
  return {
    statePath,
    removedDatasets,
    remainingDatasets: kept.length,
    updated: true,
  };
}
