import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJsonSync } from "./utils/atomic-write.js";

export const GBFS_CATALOG_LOCK_RELATIVE_PATH = "infra/docker/gbfs-catalog.lock.json";

export interface GbfsCatalogLock {
  schemaVersion: 1;
  source: "mobilitydata-gbfs";
  commit: string;
  url: string;
  sha256: string;
  lockedAt: string;
  lockedBy: string;
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

export function readGbfsCatalogLock(repoRoot: string): GbfsCatalogLock {
  const path = join(repoRoot, GBFS_CATALOG_LOCK_RELATIVE_PATH);
  if (!existsSync(path)) throw new Error(`GBFS catalog lock missing at ${path}`);
  return decodeGbfsCatalogLock(JSON.parse(readFileSync(path, "utf-8")), path);
}

export function writeGbfsCatalogLock(repoRoot: string, lock: GbfsCatalogLock): void {
  decodeGbfsCatalogLock(lock);
  const path = join(repoRoot, GBFS_CATALOG_LOCK_RELATIVE_PATH);
  atomicWriteJsonSync(
    path,
    { $schema: "./gbfs-catalog.lock.schema.json", ...lock },
    { durability: "full" },
  );
}
