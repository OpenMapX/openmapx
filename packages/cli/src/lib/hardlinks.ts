import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { repoPaths } from "./paths";

export interface HardlinkEntry {
  source: string;
  target: string;
  consumerService: string;
  dataType: string;
  targetFilename?: string;
}

export interface ApplyHardlinkOptions {
  rootDir: string;
  prune?: boolean;
}

export interface ApplyHardlinkResult {
  linked: number;
  skipped: number;
  pruned: number;
}

const HARDLINK_PLAN_FILENAME = "docker-compose.generated.hardlinks.json";

export interface ApplyGeneratedHardlinkOptions {
  rootDir?: string;
  prune?: boolean;
  /**
   * When true, throws if the generated hardlink plan file is missing.
   * Otherwise, returns `applied: false`.
   */
  requirePlan?: boolean;
}

export interface ApplyGeneratedHardlinkResult extends ApplyHardlinkResult {
  applied: boolean;
  entries: number;
  planPath: string;
}

/**
 * The compose renderer emits plan paths relative to the compose project
 * directory (e.g. `data/osm`, `data/motis/osm-pbf`). The host data root is
 * already `<infra>/data`, so strip the leading `data/` segment.
 */
function stripDataPrefix(p: string): string {
  if (p === "data" || p === "data/") return "";
  if (p.startsWith("data/")) return p.slice("data/".length);
  return p;
}

function countFilesRecursive(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (stat.isFile()) return 1;
  if (!stat.isDirectory()) return 0;
  let count = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    count += countFilesRecursive(join(path, entry.name));
  }
  return count;
}

function prunePath(path: string): number {
  if (!existsSync(path)) return 0;
  const removedFiles = countFilesRecursive(path);
  rmSync(path, { recursive: true, force: true });
  return removedFiles;
}

function linkFile(srcPath: string, tgtPath: string): ApplyHardlinkResult {
  let pruned = 0;
  if (existsSync(tgtPath)) {
    const srcStat = statSync(srcPath);
    const tgtStat = statSync(tgtPath);
    if (tgtStat.isFile() && srcStat.ino === tgtStat.ino && srcStat.dev === tgtStat.dev) {
      return { linked: 0, skipped: 1, pruned };
    }
    pruned += prunePath(tgtPath);
  }
  linkSync(srcPath, tgtPath);
  return { linked: 1, skipped: 0, pruned };
}

function mergeResults(into: ApplyHardlinkResult, next: ApplyHardlinkResult): void {
  into.linked += next.linked;
  into.skipped += next.skipped;
  into.pruned += next.pruned;
}

function linkTree(sourceDir: string, targetDir: string, prune: boolean): ApplyHardlinkResult {
  const out: ApplyHardlinkResult = { linked: 0, skipped: 0, pruned: 0 };
  if (existsSync(targetDir) && !statSync(targetDir).isDirectory()) {
    out.pruned += prunePath(targetDir);
  }
  mkdirSync(targetDir, { recursive: true });
  const sourceEntries = new Set<string>();
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    sourceEntries.add(entry.name);
    const srcPath = join(sourceDir, entry.name);
    const tgtPath = join(targetDir, entry.name);
    if (entry.isDirectory()) {
      mergeResults(out, linkTree(srcPath, tgtPath, prune));
      continue;
    }
    if (!entry.isFile()) continue;
    mergeResults(out, linkFile(srcPath, tgtPath));
  }

  if (prune) {
    for (const entry of readdirSync(targetDir, { withFileTypes: true })) {
      if (sourceEntries.has(entry.name)) continue;
      out.pruned += prunePath(join(targetDir, entry.name));
    }
  }
  return out;
}

function linkSingleFileAs(
  sourceDir: string,
  targetDir: string,
  targetFilename: string,
  prune: boolean,
): ApplyHardlinkResult {
  const files = readdirSync(sourceDir, { withFileTypes: true }).filter((entry) => entry.isFile());
  if (files.length !== 1) {
    throw new Error(
      `Cannot link ${sourceDir} as ${targetFilename}: expected exactly one source file, found ${files.length}`,
    );
  }
  const file = files[0];
  if (!file) return { linked: 0, skipped: 0, pruned: 0 };

  const out: ApplyHardlinkResult = { linked: 0, skipped: 0, pruned: 0 };
  if (existsSync(targetDir) && !statSync(targetDir).isDirectory()) {
    out.pruned += prunePath(targetDir);
  }
  mkdirSync(targetDir, { recursive: true });
  mergeResults(out, linkFile(join(sourceDir, file.name), join(targetDir, targetFilename)));

  if (prune) {
    for (const entry of readdirSync(targetDir, { withFileTypes: true })) {
      if (entry.name === targetFilename) continue;
      out.pruned += prunePath(join(targetDir, entry.name));
    }
  }
  return out;
}

export function applyHardlinkPlan(
  plan: HardlinkEntry[],
  opts: ApplyHardlinkOptions,
): ApplyHardlinkResult {
  const prune = opts.prune !== false;
  const out: ApplyHardlinkResult = { linked: 0, skipped: 0, pruned: 0 };

  for (const entry of plan) {
    const rawSource = isAbsolute(entry.source) ? entry.source : stripDataPrefix(entry.source);
    const rawTarget = isAbsolute(entry.target) ? entry.target : stripDataPrefix(entry.target);
    const source = isAbsolute(rawSource) ? rawSource : resolve(opts.rootDir, rawSource);
    const target = isAbsolute(rawTarget) ? rawTarget : resolve(opts.rootDir, rawTarget);

    if (!existsSync(source) || !statSync(source).isDirectory()) {
      if (prune) out.pruned += prunePath(target);
      continue;
    }
    if (relative(source, target) === "") continue;

    const result = entry.targetFilename
      ? linkSingleFileAs(source, target, entry.targetFilename, prune)
      : linkTree(source, target, prune);
    mergeResults(out, result);
  }

  return out;
}

export function readGeneratedHardlinkPlan(rootDir?: string): {
  plan: HardlinkEntry[];
  planPath: string;
  dataRoot: string;
} {
  const paths = repoPaths(rootDir);
  const planPath = join(paths.infraDir, HARDLINK_PLAN_FILENAME);
  const parsed = JSON.parse(readFileSync(planPath, "utf-8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Hardlink plan at ${planPath} is not an array`);
  }
  return {
    plan: parsed as HardlinkEntry[],
    planPath,
    dataRoot: join(paths.infraDir, "data"),
  };
}

export function applyGeneratedHardlinks(
  opts: ApplyGeneratedHardlinkOptions = {},
): ApplyGeneratedHardlinkResult {
  const paths = repoPaths(opts.rootDir);
  const planPath = join(paths.infraDir, HARDLINK_PLAN_FILENAME);
  if (!existsSync(planPath)) {
    if (opts.requirePlan) {
      throw new Error(`Hardlink plan not found at ${planPath}`);
    }
    return { applied: false, entries: 0, planPath, linked: 0, skipped: 0, pruned: 0 };
  }

  const { plan, dataRoot } = readGeneratedHardlinkPlan(opts.rootDir);
  const result = applyHardlinkPlan(plan, { rootDir: dataRoot, prune: opts.prune });
  return { applied: true, entries: plan.length, planPath, ...result };
}
