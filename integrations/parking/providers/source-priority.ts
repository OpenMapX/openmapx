/**
 * Source priority for deduplication and provider fanout ordering.
 * Lower values are preferred when a duplicate cluster needs a primary identity.
 */
const SOURCE_PRIORITY: Record<string, number> = {
  "de-db-bahnpark": 0,
  "de-parkapi-v3": 1,
  "de-nw-mobidrom": 1,
  "de-nw-mobidrom-pr": 2,
  // `de-apag` reads apag.de directly; `de-apag-mobidrom` reaches the same
  // operator via NRW Mobilithek and is the lower-priority backup lineage
  // (the Mobilithek exporter has been intermittently broken upstream).
  "de-apag": 1,
  "de-apag-mobidrom": 2,
  "de-parkapi-v2": 2,
  "nl-rdw": 3,
  "nl-ndw-truck": 3,
  "de-autobahn": 3,
  "fr-bnls": 4,
  "be-vlg-ghent": 4,
  "be-bru-brussels": 4,
  "ch-bs-basel": 4,
  "it-52-florence": 4,
  "es-ct-barcelona": 4,
  "at-9-vienna": 4,
  "dk-84-copenhagen": 4,
  "sg-hdb": 4,
  "es-md-madrid": 4,
  "gb-eng-utmc": 4,
  "au-nsw": 4,
  "it-32-opendatahub": 4,
  "lu-cita": 4,
  "de-apcoa": 4,
  "de-goldbeck": 4,
  // Direct city/operator feeds: all priority 4 — same tier as other
  // municipal city sources; the dedup pass falls back to source label for
  // tie-breaking when multiple feeds (e.g. NRW Mobidrom + Düsseldorf
  // direct) describe the same garage.
  "de-ni-braunschweig": 4,
  "de-hb-bremen": 4,
  "de-nw-duesseldorf": 4,
  "at-5-salzburg": 4,
  "de-nw-bielefeld": 4,
  "de-by-bamberg": 4,
  "de-rp-trier": 4,
  "de-bb-potsdam": 4,
  osm: 5,
};

export function getParkingSourcePrefix(source: string): string {
  const slashIdx = source.indexOf("/");
  const colonIdx = source.indexOf(":");
  if (slashIdx < 0 && colonIdx < 0) return source;
  if (slashIdx < 0) return source.slice(0, colonIdx);
  if (colonIdx < 0) return source.slice(0, slashIdx);
  return source.slice(0, Math.min(slashIdx, colonIdx));
}

export function getParkingSourcePriority(source: string): number {
  if (SOURCE_PRIORITY[source] !== undefined) return SOURCE_PRIORITY[source];
  return SOURCE_PRIORITY[getParkingSourcePrefix(source)] ?? 99;
}
