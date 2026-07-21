import { parseCsvRecords } from "@openmapx/mobility-formats";
import type { PoiBundledParseFn, PoiLiveState, PoiRow } from "@openmapx/poi-source-registry";

/**
 * Stadtwerke Potsdam (SWP) parking CSV bundled parser.
 *
 * Feed: `cs1-swp.westeurope.cloudapp.azure.com:8443/parking_csv` — a
 * semicolon-delimited CSV with one row per facility:
 *   `Parkplatz;Belegung;Kapazitaet;Geo Point;Dynamische Daten`
 *
 *   - `Belegung` is the OCCUPIED count (not free spaces)
 *   - `Geo Point` is `lat,lng` (note the order)
 *   - `Dynamische Daten` is the literal string "True" when live data is wired up
 *
 * The upstream feed occasionally surfaces stray entries from other cities (a
 * Wilhelmgalerie row pointing at Stuttgart has been observed). We bbox-filter
 * to Potsdam/Brandenburg [12.85, 52.32, 13.20, 52.50] to drop them rather
 * than scatter the map with mislocated pins. Names are used verbatim as the
 * stable poiId since the upstream doesn't expose numeric ids.
 */

const POTSDAM_BBOX = { west: 12.85, south: 52.32, east: 13.2, north: 52.5 };

function inDeBbPotsdamBbox(lng: number, lat: number): boolean {
  return (
    lng >= POTSDAM_BBOX.west &&
    lng <= POTSDAM_BBOX.east &&
    lat >= POTSDAM_BBOX.south &&
    lat <= POTSDAM_BBOX.north
  );
}

export const parseDeBbPotsdamBundled: PoiBundledParseFn = (buffer, { log }) => {
  const text = buffer.toString("utf-8");
  // `parseCsvRecords` strips BOM, trims fields, and handles quote-escaped
  // delimiters — battle-tested via `csv-parse`, used elsewhere in the
  // mobility data plane. The hand-rolled splitter this replaced missed BOM
  // normalisation on the first row's header key.
  let records: ReturnType<typeof parseCsvRecords>;
  try {
    records = parseCsvRecords(text, { delimiter: ";" });
  } catch {
    return { static: [], live: new Map<string, PoiLiveState>() };
  }

  const staticRows: PoiRow[] = [];
  const live = new Map<string, PoiLiveState>();
  const asOf = new Date().toISOString();
  const seen = new Set<string>();

  for (const row of records) {
    const parkplatz = row.Parkplatz;
    if (!parkplatz) continue;

    const geoMatch = (row["Geo Point"] ?? "").match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    if (!geoMatch) continue;
    const lat = Number.parseFloat(geoMatch[1]);
    const lng = Number.parseFloat(geoMatch[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (!inDeBbPotsdamBbox(lng, lat)) {
      log.debug("potsdam-de: skipping out-of-bbox entry", { name: parkplatz, lng, lat });
      continue;
    }

    // Use the name as the stable id — upstream has no numeric key. Dedupe on
    // collisions (e.g. two "Moselauen" rows) by suffixing with a counter so
    // the second physical lot isn't silently dropped by the upsert.
    let poiId = parkplatz;
    let suffix = 1;
    while (seen.has(poiId)) {
      suffix += 1;
      poiId = `${parkplatz} (${suffix})`;
    }
    seen.add(poiId);

    const capacity = Number.parseInt(row.Kapazitaet ?? "", 10);
    const occupied = Number.parseInt(row.Belegung ?? "", 10);
    const hasDynamic = (row["Dynamische Daten"] ?? "").toLowerCase() === "true";
    const isParkAndRide = parkplatz.toLowerCase().startsWith("p+r");

    staticRows.push({
      poiId,
      lng,
      lat,
      payload: {
        coordinates: [lng, lat] as [number, number],
        name: parkplatz,
        // SWP's feed mixes garages and surface P+R lots; default to surface
        // (the dominant share) and let dedup with OSM upgrade entries that
        // OSM tags as multi-storey.
        parkingType: isParkAndRide ? "surface" : "garage",
        capacity: Number.isFinite(capacity) && capacity > 0 ? capacity : undefined,
        parkAndRide: isParkAndRide || undefined,
        fee: "unknown",
        access: "public",
        operator: "Stadtwerke Potsdam",
      },
    });

    if (hasDynamic && Number.isFinite(occupied) && Number.isFinite(capacity) && capacity > 0) {
      const freeSpaces = Math.max(0, capacity - occupied);
      live.set(poiId, {
        asOf,
        freeSpaces,
      });
    }
  }

  return { static: staticRows, live };
};
