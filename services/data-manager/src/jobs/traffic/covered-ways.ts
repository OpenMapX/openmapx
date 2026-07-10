import { fetchWithTimeout } from "../transitous/motis-probe.js";

const COVERED_WAYS_FETCH_TIMEOUT_MS = 30_000;

/**
 * Parses the set of OSM way ids from an OpenConditions `/segments/speed.csv`
 * body (header `way_id,dir,current_kph,free_flow_kph,los`; the `way_id` is the
 * first column). Directions collapse to the underlying way id — the way→edge
 * map `refreshWaysToEdges` builds is keyed by way id, and `valhalla_ways_to_edges`
 * emits every directed edge for a way regardless of the sensor's direction.
 */
export function parseCoveredWayIds(csv: string): Set<number> {
  const ids = new Set<number>();
  const lines = csv.split("\n");
  // Skip the header row; a trailing newline yields an empty final entry.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    const comma = line.indexOf(",");
    const field = comma === -1 ? line : line.slice(0, comma);
    // Number("") is 0, so an empty way_id column would slip through Number.isInteger.
    if (field === "") continue;
    const wayId = Number(field);
    if (Number.isInteger(wayId)) ids.add(wayId);
  }
  return ids;
}

/**
 * Resolves the covered-way-id list `refreshWaysToEdges` needs by fetching the
 * same `${openConditionsUrl}/segments/speed.csv` feed the live-traffic writer
 * consumes, then extracting its `way_id` column. Wired into `setupCron` as
 * `getCoveredWayIds` so the way→edge refresh restricts `valhalla_ways_to_edges`
 * to the ways the writer can actually update, instead of skipping the refresh.
 */
export async function fetchCoveredWayIds(openConditionsUrl: string): Promise<Set<number>> {
  const res = await fetchWithTimeout(
    `${openConditionsUrl}/segments/speed.csv`,
    COVERED_WAYS_FETCH_TIMEOUT_MS,
  );
  if (!res.ok) {
    throw new Error(`covered-ways: OpenConditions speed feed responded ${res.status}`);
  }
  return parseCoveredWayIds(await res.text());
}
