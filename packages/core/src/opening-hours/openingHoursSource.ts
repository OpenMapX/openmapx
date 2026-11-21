/** Field-specific lineage for the chosen raw opening-hours value. */
export interface OpeningHoursSource {
  name: string;
  url?: string;
  /** Upstream field check date, not a fetch, edit, or calculation time. */
  checkedAt?: string;
}

function validCheckDate(value: string | undefined, now: Date): string | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    return undefined;
  }
  return value <= now.toISOString().slice(0, 10) ? value : undefined;
}

/** Read only OSM hours-specific tags; an element edit timestamp is not a check. */
export function openingHoursSourceFromOsm(
  id: string,
  tags: Record<string, string> | undefined,
  now = new Date(),
): OpeningHoursSource | undefined {
  const osm = /^osm:(node|way|relation)\/(\d+)$/.exec(id);
  if (!osm) return undefined;
  const taggedSource = tags?.["source:opening_hours"]?.trim();
  const name = taggedSource || "OpenStreetMap";
  const url = taggedSource
    ? /^https?:\/\//i.test(taggedSource)
      ? taggedSource
      : undefined
    : `https://www.openstreetmap.org/${osm[1]}/${osm[2]}`;
  const checkedAt =
    validCheckDate(tags?.["check_date:opening_hours"], now) ??
    validCheckDate(tags?.["opening_hours:check_date"], now);
  return { name, ...(url ? { url } : {}), ...(checkedAt ? { checkedAt } : {}) };
}
