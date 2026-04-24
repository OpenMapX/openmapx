import { existsSync, linkSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

function assertWithinRoot(label: string, pathAbs: string, rootDir: string): void {
  const rootAbs = resolve(rootDir);
  const rel = relative(rootAbs, pathAbs);
  // `relative()` returns "" for identical paths and "../…" for escapes.
  if (rel === "") return;
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`hardlink ${label} "${pathAbs}" escapes the data root "${rootAbs}"`);
  }
}

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

/**
 * The compose renderer emits plan paths relative to the compose project
 * directory (e.g. `data/osm`, `data/motis/osm-pbf`). The data-manager
 * container, however, bind-mounts `infra/docker/data/` at `/data` — so the
 * leading `data/` segment is redundant. Strip it so that `data/osm` applied
 * against `rootDir=/data` resolves to `/data/osm`, not `/data/data/osm`.
 */
function stripDataPrefix(p: string): string {
  if (p === "data" || p === "data/") return "";
  if (p.startsWith("data/")) return p.slice("data/".length);
  return p;
}

/**
 * Recursively hardlink every file under `source` into `target`, creating
 * subdirectories on the target side as needed. Required because producer
 * types like `tile-fonts` (per-fontstack subdir) and `tile-styles`
 * (per-style subdir) have nested layouts — a flat `readdirSync` would
 * skip every entry because it's a directory.
 */
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

function linkFile(
  srcPath: string,
  tgtPath: string,
): { linked: number; skipped: number; pruned: number } {
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

function linkTree(
  sourceDir: string,
  targetDir: string,
  prune: boolean,
): { linked: number; skipped: number; pruned: number } {
  let linked = 0;
  let skipped = 0;
  let pruned = 0;
  if (existsSync(targetDir) && !statSync(targetDir).isDirectory()) {
    pruned += prunePath(targetDir);
  }
  mkdirSync(targetDir, { recursive: true });
  const sourceEntries = new Set<string>();
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    sourceEntries.add(entry.name);
    const srcPath = join(sourceDir, entry.name);
    const tgtPath = join(targetDir, entry.name);
    if (entry.isDirectory()) {
      const sub = linkTree(srcPath, tgtPath, prune);
      linked += sub.linked;
      skipped += sub.skipped;
      pruned += sub.pruned;
      continue;
    }
    if (!entry.isFile()) continue;

    const res = linkFile(srcPath, tgtPath);
    linked += res.linked;
    skipped += res.skipped;
    pruned += res.pruned;
  }

  if (prune) {
    for (const entry of readdirSync(targetDir, { withFileTypes: true })) {
      if (sourceEntries.has(entry.name)) continue;
      pruned += prunePath(join(targetDir, entry.name));
    }
  }
  return { linked, skipped, pruned };
}

function linkSingleFileAs(
  sourceDir: string,
  targetDir: string,
  targetFilename: string,
  prune: boolean,
): { linked: number; skipped: number; pruned: number } {
  const files = readdirSync(sourceDir, { withFileTypes: true }).filter((entry) => entry.isFile());
  if (files.length !== 1) {
    throw new Error(
      `Cannot link ${sourceDir} as ${targetFilename}: expected exactly one source file, found ${files.length}`,
    );
  }

  const file = files[0];
  if (!file) return { linked: 0, skipped: 0, pruned: 0 };

  let pruned = 0;
  if (existsSync(targetDir) && !statSync(targetDir).isDirectory()) {
    pruned += prunePath(targetDir);
  }
  mkdirSync(targetDir, { recursive: true });
  const result = linkFile(join(sourceDir, file.name), join(targetDir, targetFilename));
  pruned += result.pruned;

  if (prune) {
    for (const entry of readdirSync(targetDir, { withFileTypes: true })) {
      if (entry.name === targetFilename) continue;
      pruned += prunePath(join(targetDir, entry.name));
    }
  }

  return { linked: result.linked, skipped: result.skipped, pruned };
}

export async function applyHardlinkPlan(
  plan: HardlinkEntry[],
  opts: ApplyHardlinkOptions,
): Promise<ApplyHardlinkResult> {
  let linked = 0;
  let skipped = 0;
  let pruned = 0;
  const prune = opts.prune !== false;

  for (const entry of plan) {
    const rawSource = isAbsolute(entry.source) ? entry.source : stripDataPrefix(entry.source);
    const rawTarget = isAbsolute(entry.target) ? entry.target : stripDataPrefix(entry.target);
    const source = isAbsolute(rawSource) ? rawSource : resolve(opts.rootDir, rawSource);
    const target = isAbsolute(rawTarget) ? rawTarget : resolve(opts.rootDir, rawTarget);
    // Constrain both sides to rootDir so malicious plans cannot hardlink or
    // delete host files outside /data (source is read-only for linkSync but
    // prune uses rmSync, which is destructive).
    assertWithinRoot("source", source, opts.rootDir);
    assertWithinRoot("target", target, opts.rootDir);

    if (!existsSync(source) || !statSync(source).isDirectory()) {
      if (prune) {
        pruned += prunePath(target);
      }
      continue;
    }
    if (relative(source, target) === "") continue; // self-link — nothing to do

    const res = entry.targetFilename
      ? linkSingleFileAs(source, target, entry.targetFilename, prune)
      : linkTree(source, target, prune);
    linked += res.linked;
    skipped += res.skipped;
    pruned += res.pruned;
  }

  return { linked, skipped, pruned };
}
