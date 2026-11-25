import { services as coreServices } from "@openmapx/core/server";

export interface CriticalAdvisory {
  reason: string;
  /** The newest affected version; later versions are not denied. */
  maxVersion?: string;
}

/**
 * The wider of two advisories for one extension. An advisory without
 * `maxVersion`, or with one that is not a version, covers every version (as
 * `criticalAdvisoryFor` reads it) and always wins; between two bounded ones
 * the higher bound wins. A later source can therefore add denials but never
 * narrow one that an earlier source, or an earlier entry, already made.
 */
export function widerAdvisory(a: CriticalAdvisory, b: CriticalAdvisory): CriticalAdvisory {
  const unbounded = (advisory: CriticalAdvisory) =>
    advisory.maxVersion === undefined ||
    coreServices.compareSemver(advisory.maxVersion, advisory.maxVersion) === null;
  if (unbounded(a)) return a;
  if (unbounded(b)) return b;
  const order = coreServices.compareSemver(a.maxVersion as string, b.maxVersion as string);
  return order === null || order >= 0 ? a : b;
}

/** Merge advisory entries by id, keeping the widest denial for each. */
export function mergeCriticalAdvisories(
  entries: Iterable<readonly [string, CriticalAdvisory]>,
): Map<string, CriticalAdvisory> {
  const merged = new Map<string, CriticalAdvisory>();
  for (const [id, advisory] of entries) {
    const current = merged.get(id);
    merged.set(id, current ? widerAdvisory(current, advisory) : advisory);
  }
  return merged;
}

/**
 * The critical advisory that denies `version` of extension `id`, if any. An
 * advisory without `maxVersion` covers every version; one with it covers the
 * versions up to and including it. An unknown version is denied, because it
 * cannot be shown to lie outside the advisory.
 */
export function criticalAdvisoryFor(
  kill: { critical: ReadonlyMap<string, CriticalAdvisory> },
  id: string,
  version: string | undefined,
): CriticalAdvisory | undefined {
  const advisory = kill.critical.get(id);
  if (!advisory || advisory.maxVersion === undefined || version === undefined) return advisory;
  const order = coreServices.compareSemver(version, advisory.maxVersion);
  return order === null || order <= 0 ? advisory : undefined;
}
