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
 * Parses the set of OSM way ids from an OpenConditions
 * `/segments/profiles.json` body. `way_id` arrives as a string because it is a
 * bigint on the wire.
 *
 * Never throws: this feed is one of two inputs to the way→edge key set, and a
 * malformed profiles response must not take down the live-speed writer that
 * shares it. A parse failure degrades to "no profile ways", which is exactly
 * the pre-existing behaviour.
 */
export function parseProfileWayIds(json: string): Set<number> {
  const ids = new Set<number>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return ids;
  }
  if (!Array.isArray(parsed)) return ids;
  for (const entry of parsed) {
    const raw = (entry as { way_id?: unknown })?.way_id;
    if (typeof raw !== "string" && typeof raw !== "number") continue;
    if (typeof raw === "string" && raw.trim() === "") continue;
    const wayId = Number(raw);
    if (Number.isInteger(wayId)) ids.add(wayId);
  }
  return ids;
}

/**
 * Parses the set of OSM way ids an OpenConditions `/segments/conditions.json`
 * body binds its road conditions to. Every span of every condition counts —
 * the map has to contain a way before a closure on it can reach an edge.
 *
 * Never throws, for the same reason {@link parseProfileWayIds} doesn't: this
 * feed is one of three inputs to the way→edge key set and the live-speed
 * writer that shares it must survive a malformed response.
 */
export function parseConditionsWayIds(json: string): Set<number> {
  const ids = new Set<number>();
  let parsed: { conditions?: unknown };
  try {
    parsed = JSON.parse(json) as { conditions?: unknown };
  } catch {
    return ids;
  }
  if (!Array.isArray(parsed?.conditions)) return ids;
  for (const condition of parsed.conditions as unknown[]) {
    const segments = (condition as { segments?: unknown } | null)?.segments;
    if (!Array.isArray(segments)) continue;
    for (const segment of segments as unknown[]) {
      const raw = (segment as { way_id?: unknown } | null)?.way_id;
      if (typeof raw !== "string" && typeof raw !== "number") continue;
      if (typeof raw === "string" && raw.trim() === "") continue;
      const wayId = Number(raw);
      if (Number.isInteger(wayId)) ids.add(wayId);
    }
  }
  return ids;
}

/**
 * Resolves the way-id key set for `refreshWaysToEdges` as the UNION of the
 * three feeds that consume the map: `/segments/speed.csv` (the live-traffic
 * writer's ways), `/segments/profiles.json` (the predicted bake's ways) and
 * `/segments/conditions.json` (the ways bound closures and caps sit on).
 *
 * The union buys almost no coverage on its own — measured on production, the
 * speed feed's ways already cover 2,560 of the 2,569 profile ways present in
 * the graph. It exists so the bake can safely re-derive the map from this set
 * immediately before reading it: keyed on profile ways alone, that refresh
 * would strip the live-only ways the every-2-minute writer needs.
 *
 * The profiles and conditions halves are best-effort: the live writer is
 * load-bearing and runs far more often, so a failing companion feed degrades
 * to the live set rather than leaving the map unwritten.
 */
export async function fetchCoveredWayIds(openConditionsUrl: string): Promise<Set<number>> {
  const res = await fetchWithTimeout(
    `${openConditionsUrl}/segments/speed.csv`,
    COVERED_WAYS_FETCH_TIMEOUT_MS,
  );
  if (!res.ok) {
    throw new Error(`covered-ways: OpenConditions speed feed responded ${res.status}`);
  }
  const ids = parseCoveredWayIds(await res.text());

  try {
    const profileRes = await fetchWithTimeout(
      `${openConditionsUrl}/segments/profiles.json`,
      COVERED_WAYS_FETCH_TIMEOUT_MS,
    );
    if (profileRes.ok) {
      for (const id of parseProfileWayIds(await profileRes.text())) ids.add(id);
    }
  } catch {
    // Best-effort: the live-speed half above is what the frequent writer needs.
  }

  try {
    const conditionsRes = await fetchWithTimeout(
      `${openConditionsUrl}/segments/conditions.json`,
      COVERED_WAYS_FETCH_TIMEOUT_MS,
    );
    if (conditionsRes.ok) {
      for (const id of parseConditionsWayIds(await conditionsRes.text())) ids.add(id);
    }
  } catch {
    // Best-effort: the live-speed half above is what the frequent writer needs.
  }

  return ids;
}
