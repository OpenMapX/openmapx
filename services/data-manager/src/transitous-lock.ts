import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeTransitousLock, type TransitousLock } from "@openmapx/transitous-core";

/**
 * `infra/docker/transitous.lock.json` pins the Transitous catalog (and its
 * `transitland-atlas` submodule) to a known commit so that an unrelated
 * upstream `feeds/*.json` schema change doesn't silently break our fetch
 * pipeline. Its shape and `parseRefShaPair` live in `@openmapx/transitous-core`.
 */
export { parseRefShaPair, type TransitousLock } from "@openmapx/transitous-core";

export const TRANSITOUS_LOCK_RELATIVE_PATH = "infra/docker/transitous.lock.json";

/**
 * Read the lockfile from `<repoRoot>/infra/docker/transitous.lock.json`.
 * Returns `null` if the file does not exist; the caller is expected to log a
 * warning and continue (existing deployments must keep working before the
 * first `transitous bump` run).
 */
export function readTransitousLock(repoRoot: string): TransitousLock | null {
  return readTransitousLockAt(repoRoot, TRANSITOUS_LOCK_RELATIVE_PATH);
}

function readTransitousLockAt(repoRoot: string, relativePath: string): TransitousLock | null {
  const lockPath = join(repoRoot, relativePath);
  // Read only: the release's pin is maintained in the repository.
  if (!existsSync(lockPath)) return null;
  const raw = readFileSync(lockPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Failed to parse Transitous lockfile at ${lockPath}: ${(error as Error).message}`,
    );
  }
  return decodeTransitousLock(parsed, `Transitous lockfile at ${lockPath}`);
}
