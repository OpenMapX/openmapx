import type { PoiBundledParseFn, PoiLiveState, PoiRow } from "@openmapx/poi-source-registry";

/**
 * Stadtwerke Bamberg car-park counter bundled parser.
 *
 * Feed: `stadtwerke-bamberg.de/carparkcounter/api/status` — JSON with one
 * `carParks` entry per facility, carrying `available`/`total`/`state` + a
 * free-form `notice`. Coordinates are NOT in the feed (only addresses), so
 * we enrich with a hand-curated, OSM-derived coordinate table keyed by
 * the operator's stable `id`. Unknown ids are dropped — when SWB adds a
 * new garage, the warning log surfaces it to a maintainer.
 *
 * The feed also contains synthetic test entries (10,000-capacity records,
 * "PH Allgemein 20") which are filtered by excluding their ids from the
 * coordinate table.
 *
 * State codes (per SWB UI): 1 = closed/disused, 4 = open, 5 = full/no data.
 */

interface BambergFacility {
  /** Display name shown on the map. Use SWB's wording verbatim where possible. */
  name: string;
  /** [lng, lat] WGS84 from OSM. */
  coordinates: [number, number];
  parkingType: "garage" | "underground" | "surface";
  /** Optional override — most entries inherit the API's `name`. */
  preferApiName?: boolean;
}

const BAMBERG_FACILITIES: Record<string, BambergFacility> = {
  "14": {
    name: "Tiefgarage Konzert- und Kongresshalle",
    coordinates: [10.8779, 49.8979],
    parkingType: "underground",
  },
  "15": {
    name: "Parkhaus Zentrum Süd",
    coordinates: [10.8941, 49.891],
    parkingType: "garage",
  },
  "17": {
    name: "Tiefgarage Zentrum Nord",
    coordinates: [10.8868, 49.8969],
    parkingType: "underground",
  },
  "22": {
    name: "Parkplatz Altes Hallenbad",
    coordinates: [10.887, 49.8987],
    parkingType: "surface",
  },
  "24": {
    name: "Innenhof Kloster Michaelsberg",
    coordinates: [10.8807, 49.8915],
    parkingType: "surface",
  },
  "28": {
    name: "Parkplatz Bambados",
    coordinates: [10.9165, 49.8927],
    parkingType: "surface",
  },
  "32": {
    name: "P+R Heinrichsdamm",
    coordinates: [10.9032, 49.8845],
    parkingType: "surface",
  },
  "34": {
    name: "Tiefgarage Luitpoldeck",
    coordinates: [10.8937, 49.8964],
    parkingType: "underground",
  },
  "40": {
    name: "P+R Bahnhof/Brennerstraße",
    coordinates: [10.898, 49.8995],
    parkingType: "surface",
  },
  "41": {
    name: "Fahrradparkhaus Bahnhof/Brennerstraße",
    coordinates: [10.898, 49.8995],
    parkingType: "garage",
  },
  "50": {
    name: "P3 Lagarde-Campus",
    coordinates: [10.905, 49.892],
    parkingType: "surface",
  },
  "51": {
    name: "P1 Lagarde-Campus",
    coordinates: [10.9055, 49.8925],
    parkingType: "surface",
  },
  "52": {
    name: "Parkhaus P2 Lagarde-Campus",
    coordinates: [10.905, 49.8923],
    parkingType: "garage",
  },
};

interface BambergCarPark {
  id?: number;
  name?: string;
  available?: number;
  total?: number;
  state?: number;
  address?: string | null;
  notice?: string | null;
}

interface BambergResponse {
  success?: boolean;
  timestamp?: string;
  cached?: boolean;
  carParks?: BambergCarPark[];
}

function mapState(state: number | undefined): "open" | "closed" | "unknown" {
  if (state === 4) return "open";
  if (state === 1 || state === 5) return "closed";
  return "unknown";
}

export const parseBambergDeBundled: PoiBundledParseFn = (buffer, { log }) => {
  let data: BambergResponse;
  try {
    data = JSON.parse(buffer.toString("utf-8")) as BambergResponse;
  } catch (err) {
    log.warn("bamberg-de: failed to parse JSON", { error: (err as Error).message });
    return { static: [], live: new Map<string, PoiLiveState>() };
  }

  if (data.success === false || !Array.isArray(data.carParks)) {
    return { static: [], live: new Map<string, PoiLiveState>() };
  }

  const staticRows: PoiRow[] = [];
  const live = new Map<string, PoiLiveState>();
  const asOf = data.timestamp || new Date().toISOString();

  for (const entry of data.carParks) {
    if (typeof entry.id !== "number") continue;
    const poiId = String(entry.id);
    const facility = BAMBERG_FACILITIES[poiId];
    if (!facility) {
      log.warn("bamberg-de: unknown facility id, skipping", { id: poiId, name: entry.name });
      continue;
    }

    const [lng, lat] = facility.coordinates;
    const capacity = typeof entry.total === "number" && entry.total > 0 ? entry.total : undefined;

    const notice = entry.notice?.trim();
    staticRows.push({
      poiId,
      lng,
      lat,
      payload: {
        coordinates: facility.coordinates,
        name: facility.preferApiName ? entry.name || facility.name : facility.name,
        parkingType: facility.parkingType,
        capacity,
        fee: "paid",
        access: "public",
        address: entry.address || undefined,
        operator: "Stadtwerke Bamberg",
        // `notice` carries operational warnings like "closed for renovation
        // June 8 – July 3", not pricing — surface as a quality warning, not
        // as the fee description.
        qualityWarnings: notice ? [notice] : undefined,
      },
    });

    const freeSpaces = typeof entry.available === "number" ? entry.available : undefined;
    const state = mapState(entry.state);
    if (freeSpaces != null || state !== "unknown") {
      live.set(poiId, {
        asOf,
        freeSpaces,
        state,
      });
    }
  }

  return { static: staticRows, live };
};
