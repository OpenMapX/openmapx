import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Schema for `infra/docker/transitous.lock.json`. Pins the Transitous catalog
 * (and its `transitland-atlas` submodule) to a known commit so that an
 * unrelated upstream `feeds/*.json` schema change doesn't silently break our
 * fetch pipeline.
 */
export interface TransitousLock {
  ref: string; // e.g. "main@<sha>"
  submodules: Record<string, string>;
  lockedAt: string;
  lockedBy: string;
  comment?: string;
}

export const TRANSITOUS_LOCK_RELATIVE_PATH = "infra/docker/transitous.lock.json";

/**
 * Read the lockfile from `<repoRoot>/infra/docker/transitous.lock.json`.
 * Returns `null` if the file does not exist; the caller is expected to log a
 * warning and continue (existing deployments must keep working before the
 * first `transitous bump` run).
 */
export function readTransitousLock(repoRoot: string): TransitousLock | null {
  const lockPath = join(repoRoot, TRANSITOUS_LOCK_RELATIVE_PATH);
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
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Transitous lockfile at ${lockPath} is not a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.ref !== "string" || !obj.ref) {
    throw new Error(`Transitous lockfile at ${lockPath} is missing required field "ref"`);
  }
  const submodulesRaw = obj.submodules;
  if (!submodulesRaw || typeof submodulesRaw !== "object" || Array.isArray(submodulesRaw)) {
    throw new Error(`Transitous lockfile at ${lockPath} is missing required field "submodules"`);
  }
  const submodules: Record<string, string> = {};
  for (const [key, value] of Object.entries(submodulesRaw as Record<string, unknown>)) {
    if (typeof value !== "string") {
      throw new Error(
        `Transitous lockfile submodule entry "${key}" at ${lockPath} is not a string SHA`,
      );
    }
    submodules[key] = value;
  }
  if (typeof obj.lockedAt !== "string") {
    throw new Error(`Transitous lockfile at ${lockPath} is missing required field "lockedAt"`);
  }
  if (typeof obj.lockedBy !== "string") {
    throw new Error(`Transitous lockfile at ${lockPath} is missing required field "lockedBy"`);
  }
  return {
    ref: obj.ref,
    submodules,
    lockedAt: obj.lockedAt,
    lockedBy: obj.lockedBy,
    comment: typeof obj.comment === "string" ? obj.comment : undefined,
  };
}

/**
 * Persist the lockfile to `<repoRoot>/infra/docker/transitous.lock.json`. The
 * `$schema` reference is preserved so editors can offer JSON-schema validation
 * even though we do not currently ship a schema file alongside it.
 */
export function writeTransitousLock(repoRoot: string, lock: TransitousLock): void {
  const lockPath = join(repoRoot, TRANSITOUS_LOCK_RELATIVE_PATH);
  const payload = {
    $schema: "./transitous.lock.schema.json",
    ref: lock.ref,
    submodules: lock.submodules,
    lockedAt: lock.lockedAt,
    lockedBy: lock.lockedBy,
    ...(lock.comment ? { comment: lock.comment } : {}),
  };
  writeFileSync(lockPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

/**
 * Split a `<branch>@<sha>` ref string into its components. Throws on
 * malformed input so callers fail loudly rather than silently checking out
 * the wrong revision.
 */
export function parseRefShaPair(ref: string): { branch: string; sha: string } {
  const at = ref.indexOf("@");
  if (at <= 0 || at === ref.length - 1) {
    throw new Error(
      `Invalid Transitous ref "${ref}" — expected "<branch>@<sha>" (e.g. "main@abc123…")`,
    );
  }
  const branch = ref.slice(0, at);
  const sha = ref.slice(at + 1);
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) {
    throw new Error(`Invalid Transitous ref "${ref}" — SHA segment "${sha}" is not a hex string`);
  }
  return { branch, sha };
}
