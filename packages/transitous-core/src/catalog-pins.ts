/**
 * The shape of the catalog pins a release ships,
 * `infra/docker/transitous.lock.json` and `infra/docker/gbfs-catalog.lock.json`.
 * Maintainers change them in the repository; at runtime they are read, never
 * written. The operations agent reads the copies its bundle carries.
 */

/** A pin of the Transitous catalog and its `transitland-atlas` submodule. */
export interface TransitousLock {
  ref: string; // e.g. "main@<sha>"
  submodules: Record<string, string>;
  lockedAt: string;
  lockedBy: string;
  comment?: string;
}

/** The pin of MobilityData's GBFS systems registry, with the registry's digest. */
export interface GbfsCatalogLock {
  schemaVersion: 1;
  source: "mobilitydata-gbfs";
  commit: string;
  url: string;
  sha256: string;
  lockedAt: string;
  lockedBy: string;
}

export function decodeTransitousLock(value: unknown, label = "Transitous lock"): TransitousLock {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not a JSON object`);
  }
  const lock = value as Record<string, unknown>;
  if (typeof lock.ref !== "string" || !lock.ref) {
    throw new Error(`${label} is missing required field "ref"`);
  }
  const rawSubmodules = lock.submodules;
  if (!rawSubmodules || typeof rawSubmodules !== "object" || Array.isArray(rawSubmodules)) {
    throw new Error(`${label} is missing required field "submodules"`);
  }
  const submodules: Record<string, string> = {};
  for (const [key, sha] of Object.entries(rawSubmodules as Record<string, unknown>)) {
    if (typeof sha !== "string") {
      throw new Error(`${label} submodule entry "${key}" is not a string SHA`);
    }
    submodules[key] = sha;
  }
  if (typeof lock.lockedAt !== "string") {
    throw new Error(`${label} is missing required field "lockedAt"`);
  }
  if (typeof lock.lockedBy !== "string") {
    throw new Error(`${label} is missing required field "lockedBy"`);
  }
  return {
    ref: lock.ref,
    submodules,
    lockedAt: lock.lockedAt,
    lockedBy: lock.lockedBy,
    ...(typeof lock.comment === "string" ? { comment: lock.comment } : {}),
  };
}

export function decodeGbfsCatalogLock(
  value: unknown,
  label = "GBFS catalog lock",
): GbfsCatalogLock {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} is not an object`);
  const lock = value as Record<string, unknown>;
  if (lock.schemaVersion !== 1 || lock.source !== "mobilitydata-gbfs")
    throw new Error(`${label} has unsupported schema/source`);
  for (const field of ["commit", "url", "sha256", "lockedAt", "lockedBy"] as const) {
    if (typeof lock[field] !== "string" || !lock[field])
      throw new Error(`${label} is missing ${field}`);
  }
  const commit = lock.commit as string;
  const url = lock.url as string;
  const sha256 = lock.sha256 as string;
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`${label} has invalid commit`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`${label} has invalid sha256`);
  if (url !== `https://raw.githubusercontent.com/MobilityData/gbfs/${commit}/systems.csv`) {
    throw new Error(`${label} URL is not pinned to its commit`);
  }
  return {
    schemaVersion: 1,
    source: "mobilitydata-gbfs",
    commit,
    url,
    sha256,
    lockedAt: lock.lockedAt as string,
    lockedBy: lock.lockedBy as string,
  };
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
