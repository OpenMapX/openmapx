import { existsSync, linkSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface HardlinkEntry {
  source: string;
  target: string;
  consumerService: string;
  dataType: string;
}

export interface ApplyHardlinkOptions {
  rootDir: string;
}

export interface ApplyHardlinkResult {
  linked: number;
  skipped: number;
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
function linkTree(sourceDir: string, targetDir: string): { linked: number; skipped: number } {
  let linked = 0;
  let skipped = 0;
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const srcPath = join(sourceDir, entry.name);
    const tgtPath = join(targetDir, entry.name);
    if (entry.isDirectory()) {
      const sub = linkTree(srcPath, tgtPath);
      linked += sub.linked;
      skipped += sub.skipped;
      continue;
    }
    if (!entry.isFile()) continue;

    if (existsSync(tgtPath)) {
      const srcStat = statSync(srcPath);
      const tgtStat = statSync(tgtPath);
      if (srcStat.ino === tgtStat.ino && srcStat.dev === tgtStat.dev) {
        skipped++;
        continue;
      }
    }
    try {
      linkSync(srcPath, tgtPath);
      linked++;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        skipped++;
      } else {
        throw err;
      }
    }
  }
  return { linked, skipped };
}

export async function applyHardlinkPlan(
  plan: HardlinkEntry[],
  opts: ApplyHardlinkOptions,
): Promise<ApplyHardlinkResult> {
  let linked = 0;
  let skipped = 0;

  for (const entry of plan) {
    const rawSource = isAbsolute(entry.source) ? entry.source : stripDataPrefix(entry.source);
    const rawTarget = isAbsolute(entry.target) ? entry.target : stripDataPrefix(entry.target);
    const source = isAbsolute(rawSource) ? rawSource : resolve(opts.rootDir, rawSource);
    const target = isAbsolute(rawTarget) ? rawTarget : resolve(opts.rootDir, rawTarget);

    if (!existsSync(source) || !statSync(source).isDirectory()) continue;
    if (relative(source, target) === "") continue; // self-link — nothing to do

    const res = linkTree(source, target);
    linked += res.linked;
    skipped += res.skipped;
  }

  return { linked, skipped };
}
