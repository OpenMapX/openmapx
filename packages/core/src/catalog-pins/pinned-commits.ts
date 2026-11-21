import type { TransitousLock } from "./types";

/** The transitland-atlas commit a Transitous lock pins; a lock without one is refused. */
export function pinnedAtlasCommit(lock: TransitousLock): string {
  const commit = lock.submodules["transitland-atlas"];
  if (!commit) throw new Error("Catalog pins have no transitland-atlas commit");
  return commit;
}

/** The Transitous commit after the `@` of a lock's `branch@sha` ref. */
export function pinnedTransitousCommit(lock: TransitousLock): string {
  const [, commit] = /@([0-9a-f]{40})$/.exec(lock.ref) ?? [];
  if (!commit) throw new Error("Catalog pins have no exact Transitous commit");
  return commit;
}
