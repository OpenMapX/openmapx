import type Redis from "ioredis";
import { ExtensionStoreError } from "./extension-store-error";

// Fixed scripts, with every accessed key supplied in KEYS. Presence flags keep
// a missing key distinct from an empty string. No shared-connection WATCH state.
export const EDIT_EXTENSION_SOURCES = `
local current = redis.call('GET', KEYS[1])
if (ARGV[1] == '0' and current ~= false) or
   (ARGV[1] == '1' and current ~= ARGV[2]) then return 0 end
-- Scripts do not roll back. If SET fails, losing the cache is safe; persisting
-- sources before a failing DEL would leave a stale catalog certified as current.
redis.call('DEL', KEYS[2])
redis.call('SET', KEYS[1], ARGV[3])
return 1
`;

export const PUBLISH_EXTENSION_CATALOG = `
local sources = redis.call('GET', KEYS[1])
if (ARGV[1] == '0' and sources ~= false) or
   (ARGV[1] == '1' and sources ~= ARGV[2]) then return 0 end
local catalog = redis.call('GET', KEYS[2])
if (ARGV[3] == '0' and catalog ~= false) or
   (ARGV[3] == '1' and catalog ~= ARGV[4]) then return 0 end
redis.call('SET', KEYS[2], ARGV[5], 'EX', ARGV[6])
return 1
`;

export const REPAIR_EXTENSION_URL_STATE = `
local sources = redis.call('GET', KEYS[1])
if (ARGV[1] == '0' and sources ~= false) or
   (ARGV[1] == '1' and sources ~= ARGV[2]) then return 0 end
local catalog = redis.call('GET', KEYS[2])
if (ARGV[3] == '0' and catalog ~= false) or
   (ARGV[3] == '1' and catalog ~= ARGV[4]) then return -1 end
redis.call('DEL', KEYS[2])
redis.call('SET', KEYS[1], ARGV[5])
return 1
`;

export interface ExtensionCacheKeys {
  sources: string;
  catalog: string;
}

export async function readExtensionSnapshot(client: Pick<Redis, "get">, key: string) {
  try {
    return await client.get(key);
  } catch {
    throw new ExtensionStoreError("source_storage_unavailable");
  }
}

function observed(raw: string | null): [string, string] {
  return [raw === null ? "0" : "1", raw ?? ""];
}

async function compareAndSet(
  client: Pick<Redis, "eval">,
  script: string,
  keys: ExtensionCacheKeys,
  args: string[],
  conflict: "source_conflict" | "catalog_conflict",
): Promise<void> {
  let result: unknown;
  try {
    result = await client.eval(script, 2, keys.sources, keys.catalog, ...args);
  } catch {
    // Includes ambiguous transport failure after execution: no retry or success.
    throw new ExtensionStoreError("source_storage_unavailable");
  }
  if (result === 0) throw new ExtensionStoreError(conflict);
  if (result !== 1) throw new ExtensionStoreError("source_storage_unavailable");
}

export function editExtensionSources(
  client: Pick<Redis, "eval">,
  keys: ExtensionCacheKeys,
  sourceSnapshot: string | null,
  nextSources: string,
): Promise<void> {
  return compareAndSet(
    client,
    EDIT_EXTENSION_SOURCES,
    keys,
    [...observed(sourceSnapshot), nextSources],
    "source_conflict",
  );
}

export function publishExtensionCatalog(
  client: Pick<Redis, "eval">,
  keys: ExtensionCacheKeys,
  sourceSnapshot: string | null,
  catalogSnapshot: string | null,
  nextCatalog: string,
  ttl: number,
): Promise<void> {
  return compareAndSet(
    client,
    PUBLISH_EXTENSION_CATALOG,
    keys,
    [...observed(sourceSnapshot), ...observed(catalogSnapshot), nextCatalog, String(ttl)],
    "catalog_conflict",
  );
}

export async function repairExtensionUrlState(
  client: Pick<Redis, "eval">,
  keys: ExtensionCacheKeys,
  sourceSnapshot: string | null,
  catalogSnapshot: string | null,
  nextSources: string,
): Promise<void> {
  let result: unknown;
  try {
    result = await client.eval(
      REPAIR_EXTENSION_URL_STATE,
      2,
      keys.sources,
      keys.catalog,
      ...observed(sourceSnapshot),
      ...observed(catalogSnapshot),
      nextSources,
    );
  } catch {
    throw new ExtensionStoreError("source_storage_unavailable");
  }
  if (result === 0) throw new ExtensionStoreError("source_conflict");
  if (result === -1) throw new ExtensionStoreError("catalog_conflict");
  if (result !== 1) throw new ExtensionStoreError("source_storage_unavailable");
}
