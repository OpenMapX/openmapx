// Shared hardlink planner used by the CLI (`openmapx data link` on the host)
// and the data-manager service (`POST /link` inside the container). Both
// places apply the same plan to the same on-disk tree — keeping the logic in
// one module avoids silent drift.
//
// The key correctness property is prune safety: consumer mounts are often
// writable (motis writes its import cache, valhalla writes tile bundles, otp
// writes graph output). A naive "delete anything in target that isn't in
// source" prune destroys those container-written files. Instead, we track
// which paths *we* linked in a sentinel manifest kept *outside* the consumer
// mount (so containers never see it), and prune only paths we previously
// managed.

import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function canonicalizeExisting(p: string): string {
  let dir = resolve(p);
  const tail: string[] = [];
  for (;;) {
    if (existsSync(dir)) {
      return tail.length ? join(realpathSync(dir), ...tail) : realpathSync(dir);
    }
    const parent = dirname(dir);
    if (parent === dir) return tail.length ? join(dir, ...tail) : dir;
    tail.unshift(basename(dir));
    dir = parent;
  }
}

export interface HardlinkEntry {
  source: string;
  target: string;
  consumerService: string;
  dataType: string;
  /** Producer-instance id for multi-instance datasets; undefined for the default/only instance. */
  instance?: string;
  /** Stable target filename requested by the consumer, if any. */
  targetFilename?: string;
}

export interface ApplyHardlinkOptions {
  /**
   * The directory that plan `source`/`target` paths resolve against when they
   * are relative. Both the CLI (host `infra/docker/data/`) and the data-manager
   * service (container `/data`) pass their respective data root here.
   */
  rootDir: string;
  /**
   * When true (default), paths we previously linked but that no longer exist
   * in the producer source are removed from the target. Container-written
   * files are never touched regardless. Set to `false` to apply-only-adds for
   * debugging.
   */
  prune?: boolean;
  /**
   * Name of the sentinel directory created under `rootDir` to track which
   * paths this planner linked (for safe prune). Override if you want multiple
   * planners sharing a `rootDir` without colliding, or to match an existing
   * deployment. Defaults to `{@link DEFAULT_SENTINEL_DIR}`.
   */
  sentinelDir?: string;
}

export interface ApplyHardlinkResult {
  linked: number;
  skipped: number;
  pruned: number;
}

/**
 * The compose renderer emits plan paths relative to the compose project
 * directory (e.g. `data/osm`, `data/motis/osm-pbf`). Both the CLI's host data
 * root (`infra/docker/data/`) and the data-manager's container data root
 * (`/data`) already represent the `data/` segment — strip the leading prefix
 * so `data/osm` applied against `rootDir=/data` resolves to `/data/osm`, not
 * `/data/data/osm`.
 */
function stripDataPrefix(p: string): string {
  if (p === "data" || p === "data/") return "";
  if (p.startsWith("data/")) return p.slice("data/".length);
  return p;
}

function assertWithinRoot(label: string, pathAbs: string, rootDir: string): void {
  const rootAbs = canonicalizeExisting(rootDir);
  const real = canonicalizeExisting(pathAbs);
  const rel = relative(rootAbs, real);
  if (rel === "") return;
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`hardlink ${label} "${pathAbs}" escapes the data root "${rootAbs}"`);
  }
}

// Fields that become a single filesystem name must stay a single name. A
// separator or a `..` here would let a plan entry address a path the
// directory-level containment check never sees.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSafeName(label: string, value: string): void {
  if (!SAFE_NAME.test(value) || value === "." || value === "..") {
    throw new Error(`hardlink ${label} "${value}" must be a plain name without path separators`);
  }
}

// Relative paths replayed out of a sentinel manifest are bookkeeping we wrote
// ourselves, but the file lives on disk and is parsed back untrusted. Only
// forward-descending POSIX paths are usable as prune targets.
function isSafeRelPath(relPath: string): boolean {
  if (!relPath || isAbsolute(relPath) || relPath.includes("\\")) return false;
  return relPath
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Reject plans where the producer source and consumer target are the same
 * directory, one contains the other, or they otherwise share an ancestor/
 * descendant relationship. Those configurations cause `linkTree` to either
 * infinite-loop or prune the source itself.
 */
function assertSourceTargetDisjoint(source: string, target: string): void {
  if (source === target) {
    throw new Error(`hardlink source and target are the same path: "${source}"`);
  }
  const sourceWithSep = source.endsWith(sep) ? source : source + sep;
  const targetWithSep = target.endsWith(sep) ? target : target + sep;
  if (target.startsWith(sourceWithSep)) {
    throw new Error(
      `hardlink target "${target}" is nested inside source "${source}" — refusing to link a tree under itself`,
    );
  }
  if (source.startsWith(targetWithSep)) {
    throw new Error(
      `hardlink source "${source}" is nested inside target "${target}" — refusing to link a tree under itself`,
    );
  }
}

/**
 * Default name of the sentinel directory created under the apply's `rootDir`.
 * Hosts can override this per call via {@link ApplyHardlinkOptions.sentinelDir}.
 */
export const DEFAULT_SENTINEL_DIR = ".hardlinks-sentinel";

interface Sentinel {
  /** Relative paths (POSIX separators) under target that we have linked in. */
  linkedPaths: string[];
  /** When the plan used `targetFilename`, record it so a rename gets pruned. */
  targetFilename?: string;
}

function sentinelPathFor(rootDir: string, sentinelDir: string, entry: HardlinkEntry): string {
  assertSafeName("consumerService", entry.consumerService);
  assertSafeName("dataType", entry.dataType);
  if (entry.instance !== undefined) assertSafeName("instance", entry.instance);
  const suffix = entry.instance ? `-${entry.instance}` : "";
  const name = `${entry.consumerService}-${entry.dataType}${suffix}.json`;
  const path = join(rootDir, sentinelDir, name);
  assertWithinRoot("sentinel", path, rootDir);
  return path;
}

function readSentinel(sentinelPath: string): Sentinel | null {
  if (!existsSync(sentinelPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(sentinelPath, "utf-8")) as unknown;
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as Record<string, unknown>;
    const linkedPaths = Array.isArray(obj.linkedPaths)
      ? obj.linkedPaths.filter((x): x is string => typeof x === "string" && isSafeRelPath(x))
      : [];
    const targetFilename = typeof obj.targetFilename === "string" ? obj.targetFilename : undefined;
    return { linkedPaths, targetFilename };
  } catch {
    return null;
  }
}

function writeSentinel(sentinelPath: string, sentinel: Sentinel): void {
  mkdirSync(dirname(sentinelPath), { recursive: true });
  writeFileSync(sentinelPath, `${JSON.stringify(sentinel, null, 2)}\n`);
}

function removeSentinel(sentinelPath: string): void {
  if (existsSync(sentinelPath)) rmSync(sentinelPath, { force: true });
}

function linkFileAt(
  srcPath: string,
  tgtPath: string,
  rootAbs: string,
): { linked: number; skipped: number } {
  assertWithinRoot("source file", srcPath, rootAbs);
  assertWithinRoot("target file", tgtPath, rootAbs);
  if (existsSync(tgtPath)) {
    const srcStat = statSync(srcPath);
    const tgtStat = statSync(tgtPath);
    if (tgtStat.isFile() && srcStat.ino === tgtStat.ino && srcStat.dev === tgtStat.dev) {
      return { linked: 0, skipped: 1 };
    }
    rmSync(tgtPath, { force: true });
  }
  mkdirSync(dirname(tgtPath), { recursive: true });
  linkSync(srcPath, tgtPath);
  return { linked: 1, skipped: 0 };
}

function collectSourceFiles(sourceDir: string, relBase = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
    const abs = join(sourceDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(abs, relPath));
    } else if (entry.isFile()) {
      out.push(relPath);
    }
  }
  return out;
}

function isWithinDir(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function pruneEmptyDirs(dir: string, stopAt: string): void {
  let current = dir;
  while (current !== stopAt && isWithinDir(stopAt, current)) {
    if (!existsSync(current)) {
      current = dirname(current);
      continue;
    }
    const entries = readdirSync(current);
    if (entries.length > 0) break;
    rmSync(current, { recursive: true, force: true });
    current = dirname(current);
  }
}

/**
 * Mirror all files from `sourceDir` into `targetDir` via hardlinks. On repeat
 * invocations, paths that were previously linked but are no longer in source
 * are pruned (tracked via the sentinel manifest). Container-written files
 * that we never linked are left alone.
 */
function linkTreeWithSentinel(
  rootAbs: string,
  sourceDir: string,
  targetDir: string,
  sentinelPath: string,
  prune: boolean,
): ApplyHardlinkResult {
  const result: ApplyHardlinkResult = { linked: 0, skipped: 0, pruned: 0 };

  // A stale file sitting where the target dir needs to be (e.g. a previous
  // targetFilename single-file mode) prevents mkdirSync from creating the
  // directory. Remove the stray file first so the layout can be re-formed.
  if (existsSync(targetDir) && !statSync(targetDir).isDirectory()) {
    rmSync(targetDir, { force: true });
    result.pruned += 1;
  }
  mkdirSync(targetDir, { recursive: true });

  const sourcePaths = collectSourceFiles(sourceDir);
  const sourceSet = new Set(sourcePaths);

  for (const relPath of sourcePaths) {
    const srcPath = join(sourceDir, ...relPath.split("/"));
    const tgtPath = join(targetDir, ...relPath.split("/"));
    const r = linkFileAt(srcPath, tgtPath, rootAbs);
    result.linked += r.linked;
    result.skipped += r.skipped;
  }

  if (prune) {
    const old = readSentinel(sentinelPath);
    const previouslyLinked = old?.linkedPaths ?? [];
    for (const relPath of previouslyLinked) {
      if (sourceSet.has(relPath)) continue;
      const tgtPath = join(targetDir, ...relPath.split("/"));
      assertWithinRoot("prune target", tgtPath, rootAbs);
      if (existsSync(tgtPath)) {
        rmSync(tgtPath, { force: true });
        result.pruned += 1;
        pruneEmptyDirs(dirname(tgtPath), targetDir);
      }
    }
    // If the consumer previously used targetFilename and the plan now uses
    // tree mode (or vice versa), the old single file is captured via
    // `previouslyLinked`, so no extra handling needed here.
  }

  writeSentinel(sentinelPath, { linkedPaths: sourcePaths });
  return result;
}

function linkSingleFileWithSentinel(
  rootAbs: string,
  sourceDir: string,
  targetDir: string,
  targetFilename: string,
  sentinelPath: string,
  prune: boolean,
): ApplyHardlinkResult {
  const result: ApplyHardlinkResult = { linked: 0, skipped: 0, pruned: 0 };

  const files = readdirSync(sourceDir, { withFileTypes: true }).filter((entry) => entry.isFile());
  if (files.length !== 1) {
    throw new Error(
      `cannot link ${sourceDir} as ${targetFilename}: expected exactly one source file, found ${files.length}`,
    );
  }
  const file = files[0];
  if (!file) return result;

  if (existsSync(targetDir) && !statSync(targetDir).isDirectory()) {
    rmSync(targetDir, { force: true });
    result.pruned += 1;
  }
  mkdirSync(targetDir, { recursive: true });

  const tgtPath = join(targetDir, targetFilename);
  const r = linkFileAt(join(sourceDir, file.name), tgtPath, rootAbs);
  result.linked += r.linked;
  result.skipped += r.skipped;

  if (prune) {
    const old = readSentinel(sentinelPath);
    // If the previous apply used a different filename, prune it. Previously
    // linked tree-mode files (in subdirs) also go here.
    for (const relPath of old?.linkedPaths ?? []) {
      if (relPath === targetFilename) continue;
      const prev = join(targetDir, ...relPath.split("/"));
      assertWithinRoot("prune target", prev, rootAbs);
      if (existsSync(prev)) {
        rmSync(prev, { force: true });
        result.pruned += 1;
        pruneEmptyDirs(dirname(prev), targetDir);
      }
    }
  }

  writeSentinel(sentinelPath, { linkedPaths: [targetFilename], targetFilename });
  return result;
}

/**
 * Apply a hardlink plan to disk.
 *
 * **Correctness model.** Each consumer `{ consumerService, dataType, instance }`
 * tuple has a sentinel JSON stored at `<rootDir>/.openmapx-hardlinks/…`
 * listing the relative paths we linked on the previous apply. A new apply:
 *
 * 1. re-links every current source file into the target (skip if already
 *    hardlinked by inode match);
 * 2. for every path in the old sentinel that is no longer in source, delete
 *    it from target (only when `prune !== false`);
 * 3. writes a new sentinel with the current linked set.
 *
 * Files created inside the target by the consumer container (e.g. motis's
 * `/motis-data/data/nigiri.cache`, valhalla's `valhalla_tiles.tar`) are never
 * in a sentinel and are therefore never touched.
 */
export function applyHardlinkPlan(
  plan: HardlinkEntry[],
  opts: ApplyHardlinkOptions,
): ApplyHardlinkResult {
  const prune = opts.prune !== false;
  const sentinelDir = opts.sentinelDir ?? DEFAULT_SENTINEL_DIR;
  const rootAbs = resolve(opts.rootDir);
  const result: ApplyHardlinkResult = { linked: 0, skipped: 0, pruned: 0 };

  for (const entry of plan) {
    const rawSource = isAbsolute(entry.source) ? entry.source : stripDataPrefix(entry.source);
    const rawTarget = isAbsolute(entry.target) ? entry.target : stripDataPrefix(entry.target);
    const source = isAbsolute(rawSource) ? rawSource : resolve(rootAbs, rawSource);
    const target = isAbsolute(rawTarget) ? rawTarget : resolve(rootAbs, rawTarget);

    assertWithinRoot("source", source, rootAbs);
    assertWithinRoot("target", target, rootAbs);
    assertSourceTargetDisjoint(source, target);
    if (entry.targetFilename !== undefined) {
      assertSafeName("targetFilename", entry.targetFilename);
    }

    const sentinelPath = sentinelPathFor(rootAbs, sentinelDir, entry);

    if (!existsSync(source) || !statSync(source).isDirectory()) {
      // Producer disappeared — drop everything we previously linked, but leave
      // any container-written artifacts alone.
      if (prune) {
        const old = readSentinel(sentinelPath);
        for (const relPath of old?.linkedPaths ?? []) {
          const tgtPath = join(target, ...relPath.split("/"));
          assertWithinRoot("prune target", tgtPath, rootAbs);
          if (existsSync(tgtPath)) {
            rmSync(tgtPath, { force: true });
            result.pruned += 1;
            pruneEmptyDirs(dirname(tgtPath), target);
          }
        }
        removeSentinel(sentinelPath);
        // Only remove the target dir itself when it's empty; container state
        // stays untouched even after a producer is deconfigured.
        if (existsSync(target) && readdirSync(target).length === 0) {
          rmSync(target, { recursive: true, force: true });
        }
      }
      continue;
    }

    const r = entry.targetFilename
      ? linkSingleFileWithSentinel(
          rootAbs,
          source,
          target,
          entry.targetFilename,
          sentinelPath,
          prune,
        )
      : linkTreeWithSentinel(rootAbs, source, target, sentinelPath, prune);
    result.linked += r.linked;
    result.skipped += r.skipped;
    result.pruned += r.pruned;
  }

  return result;
}
