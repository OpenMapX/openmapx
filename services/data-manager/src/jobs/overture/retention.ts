import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { sql } from "../../db/index.js";
import { assertValidOvertureSchema } from "./schema.js";
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

/** Numeric YYYY-MM-DD.N ordering; positive means `left` is newer. */
export function compareOvertureReleases(left: string, right: string): number {
  assertValidOvertureRelease(left);
  assertValidOvertureRelease(right);
  const [leftDate = "", leftRevision = "0"] = left.split(".");
  const [rightDate = "", rightRevision = "0"] = right.split(".");
  return leftDate.localeCompare(rightDate) || Number(leftRevision) - Number(rightRevision);
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
    .sort((left, right) => compareOvertureReleases(right, left));

  // A manually pinned older active release must never delete a newer pulled
  // snapshot whose ingest may merely be awaiting operator attention. Retention
  // applies to the active release and its predecessors; newer directories stay
  // protected until one of them becomes active.
  const newer = releases.filter(
    (release) => compareOvertureReleases(release, opts.activeRelease) > 0,
  );
  const predecessors = releases.filter(
    (release) => compareOvertureReleases(release, opts.activeRelease) < 0,
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

/**
 * Runs release-file retention once per completed conflation state. The durable
 * marker is written only after filesystem pruning succeeds, so a crash remains
 * safely retryable without rescanning on every steady-state retry tick.
 */
export async function finalizeOvertureReleaseFiles(
  opts: PruneOvertureReleasesOptions & { schema?: string },
): Promise<PruneOvertureReleasesResult | null> {
  const schema = opts.schema ?? "overture_places";
  assertValidOvertureSchema(schema);
  assertValidOvertureRelease(opts.activeRelease);
  const [state] = await sql.unsafe<{ release_files_pruned_at: Date | string | null }[]>(
    `SELECT release_files_pruned_at
     FROM "${schema}".conflation_state
     WHERE singleton = 1 AND release = $1 AND status = 'completed'`,
    [opts.activeRelease],
  );
  if (!state) {
    throw new Error(
      `Cannot finalize Overture retention before ${opts.activeRelease} conflation completes`,
    );
  }
  if (state.release_files_pruned_at !== null) return null;

  const result = pruneOvertureReleases(opts);
  await sql.unsafe(
    `UPDATE "${schema}".conflation_state
     SET release_files_pruned_at = COALESCE(release_files_pruned_at, NOW()),
         updated_at = NOW()
     WHERE singleton = 1 AND release = $1 AND status = 'completed'`,
    [opts.activeRelease],
  );
  return result;
}
