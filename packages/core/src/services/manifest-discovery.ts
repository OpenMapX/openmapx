import { type Dirent, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Directories whose subtrees never hold a service manifest. Skipping them keeps
 * the scan fast and stops a community repo from baiting it into a huge vendored
 * tree. Dot-directories are skipped separately (by the leading-`.` check).
 */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "__pycache__",
]);

/**
 * How many directory levels below the repo root a `service.json` may sit.
 * Deep enough for a manifest to live beside its service (e.g.
 * `services/ingest/service.json`), bounded so a deeply-nested tree can't drive
 * an unbounded walk. The repo root itself is depth 0.
 */
const MAX_DEPTH = 4;

/**
 * Hard ceiling on directories visited per repo — a denial-of-service backstop
 * against a very wide or adversarial tree, independent of `MAX_DEPTH`.
 */
const MAX_DIRS = 2_000;

/**
 * Finds every directory under `repoRoot` that directly contains a `service.json`,
 * walking up to {@link MAX_DEPTH} levels so a community manifest can live next to
 * its service rather than only at the repo root. Returns absolute-or-rooted
 * directory paths (whatever form `repoRoot` was given in).
 *
 * Safety properties for untrusted (community-cloned) repos:
 * - a directory that holds a manifest is a service leaf — it is recorded and not
 *   descended into (no service nested inside a service);
 * - symlinked directories are never traversed (`readdir` reports a symlink's own
 *   dirent type, so `isDirectory()` is false for them) and a symlinked
 *   `service.json` is rejected (checked with `lstat`, which does not follow
 *   links) — together this prevents escaping the repo via a link;
 * - heavy/irrelevant directories and dot-directories are skipped;
 * - the depth limit and the {@link MAX_DIRS} cap bound total work.
 */
export function findServiceManifestDirs(repoRoot: string): string[] {
  const found: string[] = [];
  let visited = 0;

  const walk = (dir: string, depth: number): void => {
    if (visited >= MAX_DIRS) return;
    visited++;

    // A real (non-symlink) service.json here makes this dir a service leaf.
    let isManifest = false;
    try {
      isManifest = lstatSync(join(dir, "service.json")).isFile();
    } catch {
      isManifest = false;
    }
    if (isManifest) {
      found.push(dir);
      return;
    }
    if (depth >= MAX_DEPTH) return;

    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // isDirectory() is false for symlinks (readdir returns the link's own
      // dirent type), so symlinked directories are never traversed.
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), depth + 1);
    }
  };

  walk(repoRoot, 0);
  return found;
}
