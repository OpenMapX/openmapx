/**
 * Source priority for merge primary selection. Lower values win.
 *
 * National or official aggregator feeds are preferred over global fallback
 * sources because they usually expose the clearest license and operator data
 * for their territory.
 */
const SOURCE_PRIORITY: Record<string, number> = {
  "us-afdc": 0,
  "de-bnetza": 0,
  "de-ocpdb": 0,
  "fr-irve": 0,
  "ch-sfoe": 0,
  "nl-dotnl": 0,
  "no-nobil": 0,
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
