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
  "ie-esb": 0,
  "cy-cynap": 0,
  "lu-chargy": 0,
  "nz-evroam": 0,
  "es-dgt": 0,
  "it-pun": 0,
  "au-nsw-ev": 0,
  "au-qld-ev": 0,
  "au-vic-ev": 0,
  "be-flanders": 0,
  "be-wallonia": 0,
  "hk-epd": 0,
  "fi-digitraffic": 0,
  "lt-vialietuva": 0,
  "ch-sfoe": 0,
  "nl-dotnl": 0,
  "no-nobil": 0,
  "si-nap": 0,
  "kr-datago": 0,
  "pl-eipa": 0,
  "sg-ltadatamall": 0,
  "tw-tdx": 0,
  "at-econtrol": 0,
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
