import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertValidOvertureRelease } from "./stac.js";

export interface PruneOvertureReleasesOptions {
  dataDir: string;
  activeRelease: string;
  /** Total completed release directories to retain, including the active one. */
  retain?: number;
  onProgress?: (message: string) => void;
}

export interface PruneOvertureReleasesResult {
  retained: string[];
  removed: string[];
}

const RELEASE_DIRECTORY = /^\d{4}-\d{2}-\d{2}\.\d+$/;

function compareReleasesNewestFirst(left: string, right: string): number {
  const [leftDate = "", leftRevision = "0"] = left.split(".");
  const [rightDate = "", rightRevision = "0"] = right.split(".");
  return rightDate.localeCompare(leftDate) || Number(rightRevision) - Number(leftRevision);
}

export function overtureReleaseRetentionFromEnv(value: string | undefined): number {
  if (!value) return 2;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 12) {
    throw new Error("OVERTURE_RELEASE_RETENTION must be an integer between 1 and 12");
  }
  return parsed;
}

/**
 * Retains the active immutable snapshot and the newest known-good predecessors.
 * It is called only after ingest, fused quality validation, and conflation have
 * all completed, so a failed refresh never destroys its rollback input.
 */
export function pruneOvertureReleases(
  opts: PruneOvertureReleasesOptions,
): PruneOvertureReleasesResult {
  assertValidOvertureRelease(opts.activeRelease);
  const retain = opts.retain ?? 2;
  if (!Number.isSafeInteger(retain) || retain < 1) {
    throw new Error("Overture release retention must be at least 1");
  }

  const root = resolve(opts.dataDir, "overture");
  if (!existsSync(root)) return { retained: [], removed: [] };
  const releases = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && RELEASE_DIRECTORY.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareReleasesNewestFirst);

  // A manually pinned older active release must never delete a newer pulled
  // snapshot whose ingest may merely be awaiting operator attention. Retention
  // applies to the active release and its predecessors; newer directories stay
  // protected until one of them becomes active.
  const newer = releases.filter(
    (release) => compareReleasesNewestFirst(release, opts.activeRelease) < 0,
  );
  const predecessors = releases.filter(
    (release) => compareReleasesNewestFirst(release, opts.activeRelease) > 0,
  );
  const retained = [...newer, opts.activeRelease, ...predecessors.slice(0, retain - 1)];
  const keep = new Set(retained);
  const removed: string[] = [];
  for (const release of releases) {
    if (keep.has(release)) continue;
    assertValidOvertureRelease(release);
    const target = resolve(root, release);
    if (target !== join(root, release)) {
      throw new Error(`Refusing to prune Overture release outside ${root}: ${target}`);
    }
    rmSync(target, { recursive: true, force: true });
    removed.push(release);
    opts.onProgress?.(`Pruned superseded Overture snapshot ${release}.`);
  }
  return { retained, removed };
}
