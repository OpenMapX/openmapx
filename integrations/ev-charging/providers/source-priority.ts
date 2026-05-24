/**
 * Source priority for merge primary selection. Lower values win.
 *
 * National or official aggregator feeds are preferred over global fallback
 * sources because they usually expose the clearest license and operator data
 * for their territory.
 */
const SOURCE_PRIORITY: Record<string, number> = {
  afdc: 0,
  "bnetza-ev": 0,
  "france-irve": 0,
  "switzerland-ev": 0,
  nobil: 0,
  ocm: 3,
  osm: 5,
};

export function getEvChargingSourcePrefix(source: string): string {
  const slashIdx = source.indexOf("/");
  const colonIdx = source.indexOf(":");
  if (slashIdx < 0 && colonIdx < 0) return source;
  if (slashIdx < 0) return source.slice(0, colonIdx);
  if (colonIdx < 0) return source.slice(0, slashIdx);
  return source.slice(0, Math.min(slashIdx, colonIdx));
}

export function getEvChargingSourcePriority(source: string): number {
  if (SOURCE_PRIORITY[source] !== undefined) return SOURCE_PRIORITY[source];
  return SOURCE_PRIORITY[getEvChargingSourcePrefix(source)] ?? 99;
}
