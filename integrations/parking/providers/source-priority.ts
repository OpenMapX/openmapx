/**
 * Source priority for deduplication and provider fanout ordering.
 * Lower values are preferred when a duplicate cluster needs a primary identity.
 */
const SOURCE_PRIORITY: Record<string, number> = {
  "db-bahnpark": 0,
  "parkapi-v3": 1,
  "nrw-mobidrom-parking": 1,
  "nrw-mobidrom-pr": 2,
  // apag-direct is preferred over the Mobilithek-mediated apag feed: same
  // operator + same uuids upstream, but fetched without the middleman so it
  // stays live when Mobilithek's exporter is broken.
  "apag-direct": 1,
  apag: 2,
  "parkapi-v2": 2,
  "rdw-nl": 3,
  "ndw-truck-nl": 3,
  "autobahn-de": 3,
  "bnls-fr": 4,
  "ghent-be": 4,
  "brussels-be": 4,
  "basel-ch": 4,
  "florence-it": 4,
  "barcelona-es": 4,
  "vienna-at": 4,
  "copenhagen-dk": 4,
  singapore: 4,
  "madrid-es": 4,
  "utmc-newcastle": 4,
  "nsw-au": 4,
  "opendatahub-it": 4,
  "cita-lu": 4,
  apcoa: 4,
  goldbeck: 4,
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
