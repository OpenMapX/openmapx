import type {
  PoiBundledParseFn,
  PoiLiveState,
  PoiRow,
  PoiSourceLogger,
} from "@openmapx/poi-source-registry";

/**
 * Transport for NSW Car Park bundled parser.
 *
 * The TfNSW Car Park API is federated:
 *   - `GET /v1/carpark` returns a bare array of `{ facility_id, facility_name }`.
 *   - `GET /v1/carpark?facility=ID` returns the full detail object (capacity,
 *     coordinates, live occupancy, MessageDate).
 *
 * The pre-migration in-memory provider only fetched details for visible
 * (bbox-overlapping) facilities; the pipeline model requires ingesting every
 * facility once, so this parser fans out across all ~45 facilities returned by
 * the list endpoint. Concurrency is capped at NSW_CONCURRENCY (5) — same shape
 * as parkapi-v2's per-city fan-out.
 *
 * Static payload carries the per-facility metadata; live state carries the
 * fresh `MessageDate` + `occupancy.total` + `spots`. mergeNswAuLive derives
 * freeSpaces and the dataUpdatedAt timestamps.
 *
 * Auth is the same `Authorization: apikey <KEY>` header the data-manager
 * fetch stage already attaches via resolveHeaders — we forward it to the
 * per-facility detail calls inside the parser by reading the same env var.
 */

const API_BASE = "https://api.transport.nsw.gov.au/v1";
const PER_DETAIL_TIMEOUT_MS = 10_000;
const NSW_CONCURRENCY = 5;

interface NswFacilityListEntry {
  facility_id: string;
  facility_name: string;
}

interface NswZone {
  spots: string;
  zone_id: string;
  zone_name: string;
  parent_zone_id: string;
  occupancy: {
    loop: string | null;
    total: string | null;
    monthlies: string | null;
    open_gate: string | null;
    transients: string | null;
  };
}

interface NswFacilityDetail {
  tsn: string;
  time: string;
  spots: string;
  zones: NswZone[];
  ParkID: string;
  location: {
    suburb: string;
    address: string;
    latitude: string;
    longitude: string;
  };
  occupancy: {
    loop: string | null;
    total: string | null;
    monthlies: string | null;
    open_gate: string | null;
    transients: string | null;
  };
  MessageDate: string;
  facility_id: string;
  facility_name: string;
  tfnsw_facility_id: string;
}

interface KnownFacility {
  name: string;
  lat: number;
  lng: number;
  capacity: number;
}

/**
 * Static lookup of all 44 facilities published in the TfNSW Car Park API
 * documentation v2.3, section 4 ("Car Parks"). Coordinates are the TSN
 * (station) coordinates from the documentation; the per-facility detail
 * endpoint returns the actual car-park-entrance coordinates in `location`
 * and overrides this fallback when fetched.
 */
const KNOWN_FACILITIES: Record<string, KnownFacility> = {
  "1": { name: "Tallawong Station Car Park", lat: -33.69163, lng: 150.906022, capacity: 1004 },
  "2": { name: "Kellyville Station Car Park", lat: -33.713514, lng: 150.935304, capacity: 1374 },
  "3": { name: "Bella Vista Station Car Park", lat: -33.730592, lng: 150.944024, capacity: 800 },
  "4": {
    name: "Hills Showground Station Car Park",
    lat: -33.72782,
    lng: 150.987345,
    capacity: 600,
  },
  "5": { name: "Cherrybrook Station Car Park", lat: -33.736703, lng: 151.031977, capacity: 400 },
  "6": {
    name: "Park&Ride - Gordon Henry St (north)",
    lat: -33.756009,
    lng: 151.154528,
    capacity: 213,
  },
  "7": { name: "Park&Ride - Kiama", lat: -34.672518, lng: 150.854695, capacity: 42 },
  "8": { name: "Park&Ride - Gosford", lat: -33.423883, lng: 151.341711, capacity: 1057 },
  "9": { name: "Park&Ride - Revesby", lat: -33.95246, lng: 151.014838, capacity: 934 },
  "10": { name: "Park&Ride - Warriewood", lat: -33.697777, lng: 151.300667, capacity: 244 },
  "11": { name: "Park&Ride - Narrabeen", lat: -33.713514, lng: 151.297315, capacity: 46 },
  "12": { name: "Park&Ride - Mona Vale", lat: -33.677276, lng: 151.305146, capacity: 68 },
  "13": { name: "Park&Ride - Dee Why", lat: -33.752797, lng: 151.286485, capacity: 117 },
  "14": { name: "Park&Ride - West Ryde", lat: -33.807172, lng: 151.090229, capacity: 151 },
  "15": {
    name: "Park&Ride - Sutherland East Parade",
    lat: -34.031787,
    lng: 151.05719,
    capacity: 373,
  },
  "16": { name: "Park&Ride - Leppington", lat: -33.9544, lng: 150.8081, capacity: 1884 },
  "17": {
    name: "Park&Ride - Edmondson Park (south)",
    lat: -33.9693,
    lng: 150.8587,
    capacity: 1431,
  },
  "18": { name: "Park&Ride - St Marys", lat: -33.762256, lng: 150.776029, capacity: 682 },
  "19": {
    name: "Park&Ride - Campbelltown Farrow Rd (north)",
    lat: -34.063835,
    lng: 150.813929,
    capacity: 68,
  },
  "20": {
    name: "Park&Ride - Campbelltown Hurley St",
    lat: -34.063835,
    lng: 150.813929,
    capacity: 118,
  },
  "21": { name: "Park&Ride - Penrith (at-grade)", lat: -33.750055, lng: 150.696135, capacity: 230 },
  "22": {
    name: "Park&Ride - Penrith (multi-level)",
    lat: -33.750055,
    lng: 150.696135,
    capacity: 1144,
  },
  "23": { name: "Park&Ride - Warwick Farm", lat: -33.91345, lng: 150.935036, capacity: 910 },
  "24": { name: "Park&Ride - Schofields", lat: -33.704477, lng: 150.873817, capacity: 700 },
  "25": { name: "Park&Ride - Hornsby", lat: -33.702801, lng: 151.098494, capacity: 145 },
  "26": { name: "Park&Ride - Tallawong P1", lat: -33.69163, lng: 150.906022, capacity: 121 },
  "27": { name: "Park&Ride - Tallawong P2", lat: -33.69163, lng: 150.906022, capacity: 455 },
  "28": { name: "Park&Ride - Tallawong P3", lat: -33.69163, lng: 150.906022, capacity: 397 },
  "29": { name: "Park&Ride - Kellyville (north)", lat: -33.713514, lng: 150.935304, capacity: 351 },
  "30": { name: "Park&Ride - Kellyville (south)", lat: -33.713514, lng: 150.935304, capacity: 964 },
  "31": { name: "Park&Ride - Bella Vista", lat: -33.730592, lng: 150.944024, capacity: 777 },
  "32": { name: "Park&Ride - Hills Showground", lat: -33.72782, lng: 150.987345, capacity: 584 },
  "33": { name: "Park&Ride - Cherrybrook", lat: -33.736703, lng: 151.031977, capacity: 384 },
  "34": {
    name: "Park&Ride - Lindfield Village Green",
    lat: -33.775185,
    lng: 151.169111,
    capacity: 94,
  },
  "35": { name: "Park&Ride - Beverly Hills", lat: -33.948849, lng: 151.081692, capacity: 200 },
  "36": { name: "Park&Ride - Emu Plains", lat: -33.745527, lng: 150.66987, capacity: 751 },
  "37": { name: "Park&Ride - Riverwood", lat: -33.952727, lng: 151.050035, capacity: 142 },
  "38": { name: "Park&Ride - North Rocks", lat: -33.765539, lng: 151.014131, capacity: 139 },
  "39": {
    name: "Park&Ride - Edmondson Park (north)",
    lat: -33.969123,
    lng: 150.861594,
    capacity: 917,
  },
  "486": { name: "Park&Ride - Ashfield", lat: -33.8875506079, lng: 151.125504163, capacity: 225 },
  "487": { name: "Park&Ride - Kogarah", lat: -33.9621493059, lng: 151.132641462, capacity: 259 },
  "488": {
    name: "Park&Ride - Seven Hills",
    lat: -33.774430434,
    lng: 150.936513359,
    capacity: 1613,
  },
  "489": { name: "Park&Ride - Manly Vale", lat: -33.786247, lng: 151.26671, capacity: 142 },
  "490": { name: "Park&Ride - Brookvale", lat: -33.767508, lng: 151.268541, capacity: 246 },
};

function parseIntStrict(value: string | null | undefined): number | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function authHeaders(): Record<string, string> | null {
  const apiKey = process.env.NSW_TRANSPORT_API_KEY;
  if (!apiKey) return null;
  return {
    Authorization: `apikey ${apiKey}`,
    Accept: "application/json",
  };
}

async function fetchDetail(facilityId: string): Promise<NswFacilityDetail | null> {
  const headers = authHeaders();
  if (!headers) return null;
  try {
    const res = await globalThis.fetch(
      `${API_BASE}/carpark?facility=${encodeURIComponent(facilityId)}`,
      {
        headers,
        signal: AbortSignal.timeout(PER_DETAIL_TIMEOUT_MS),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as NswFacilityDetail;
    if (!data || typeof data !== "object" || !data.facility_id) return null;
    return data;
  } catch {
    return null;
  }
}

async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;
  async function run(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => run());
  await Promise.all(workers);
  return results;
}

function parseList(buffer: Buffer, log: PoiSourceLogger): NswFacilityListEntry[] {
  try {
    const data = JSON.parse(buffer.toString("utf-8"));
    if (!Array.isArray(data)) return [];
    return (data as NswFacilityListEntry[]).filter(
      (e): e is NswFacilityListEntry => !!e?.facility_id,
    );
  } catch (err) {
    log.warn("nsw-au: failed to parse facility list", { error: (err as Error).message });
    return [];
  }
}

export const parseNswAuBundled: PoiBundledParseFn = async (buffer, { log }) => {
  const entries = parseList(buffer, log);
  if (entries.length === 0) {
    return { static: [], live: new Map<string, PoiLiveState>() };
  }

  const details = await mapWithConcurrency(entries, NSW_CONCURRENCY, async (entry) => {
    return { entry, detail: await fetchDetail(entry.facility_id) };
  });

  const staticRows: PoiRow[] = [];
  const live = new Map<string, PoiLiveState>();

  for (const { entry, detail } of details) {
    const facilityId = entry.facility_id;
    const known = KNOWN_FACILITIES[facilityId];

    let lat: number | undefined;
    let lng: number | undefined;
    let capacity: number | undefined;
    let address: string | undefined;

    if (known) {
      lat = known.lat;
      lng = known.lng;
      capacity = known.capacity;
    }

    if (detail) {
      const detailLat = Number(detail.location?.latitude);
      const detailLng = Number(detail.location?.longitude);
      if (Number.isFinite(detailLat) && Number.isFinite(detailLng)) {
        lat = detailLat;
        lng = detailLng;
      }
      const detailSpots = parseIntStrict(detail.spots);
      if (detailSpots != null && detailSpots > 0) {
        capacity = detailSpots;
      }
      if (detail.location?.address) {
        address = [detail.location.address, detail.location.suburb].filter(Boolean).join(", ");
      }

      const detailTotal = parseIntStrict(detail.occupancy?.total ?? null);
      if (detailSpots != null && detailTotal != null) {
        live.set(facilityId, {
          asOf: detail.MessageDate || new Date().toISOString(),
          spots: detailSpots,
          total: detailTotal,
        });
      }
    }

    if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const name = entry.facility_name || known?.name || `Car Park ${facilityId}`;

    staticRows.push({
      poiId: facilityId,
      lng,
      lat,
      payload: {
        coordinates: [lng, lat] as [number, number],
        name,
        parkingType: "surface",
        capacity: capacity != null && capacity > 0 ? capacity : undefined,
        fee: "free",
        parkAndRide: true,
        address,
      },
    });
  }

  return { static: staticRows, live };
};

// Re-exported for tests so they can drive the build function without going
// through the bundled fetch path.
export { KNOWN_FACILITIES, type NswFacilityDetail, type NswFacilityListEntry, parseIntStrict };
