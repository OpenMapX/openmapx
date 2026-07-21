import type { PoiBundledParseFn, PoiLiveState, PoiRow } from "@openmapx/poi-source-registry";

/**
 * Stadt Braunschweig PULP parking GeoJSON bundled parser.
 *
 * Single GeoJSON FeatureCollection — point geometry per parkhaus. Realtime
 * fields (`occupancy`, `free`, `capacity`, `timestamp`, `openingState`) are
 * present on facilities that report live availability; the rest are static-
 * only entries (private/operator parking with no occupancy feed). We emit one
 * PoiRow per feature and a PoiLiveState whenever `free` is present.
 */

interface BraunschweigFeatureProperties {
  externalId?: string | null;
  id?: string;
  name?: string;
  title?: string;
  description?: string;
  type?: string;
  openingState?: string;
  capacity?: number;
  free?: number;
  occupancy?: number;
  occupancyRate?: number;
  trend?: string;
  subTypes?: string[];
  timestamp?: string;
}

interface BraunschweigFeature {
  type: "Feature";
  id?: string;
  geometry?: { type: "Point"; coordinates: [number, number] };
  properties?: BraunschweigFeatureProperties;
}

interface BraunschweigGeoJsonResponse {
  type?: "FeatureCollection";
  features?: BraunschweigFeature[];
}

function mapOpeningState(state?: string): "open" | "closed" | "unknown" {
  if (state === "open") return "open";
  if (state === "closed") return "closed";
  return "unknown";
}

function mapTrend(trend?: string): "increasing" | "decreasing" | "constant" | undefined {
  if (trend === "increasing" || trend === "steigend") return "increasing";
  if (trend === "decreasing" || trend === "fallend") return "decreasing";
  if (trend === "constant" || trend === "konstant") return "constant";
  return undefined;
}

export const parseDeNiBraunschweigBundled: PoiBundledParseFn = (buffer) => {
  let data: BraunschweigGeoJsonResponse;
  try {
    data = JSON.parse(buffer.toString("utf-8")) as BraunschweigGeoJsonResponse;
  } catch {
    return { static: [], live: new Map<string, PoiLiveState>() };
  }
  if (!Array.isArray(data?.features)) {
    return { static: [], live: new Map<string, PoiLiveState>() };
  }

  const staticRows: PoiRow[] = [];
  const live = new Map<string, PoiLiveState>();
  const fallbackAsOf = new Date().toISOString();

  for (const feature of data.features) {
    const props = feature.properties ?? {};
    const poiId = feature.id ?? props.id;
    if (!poiId) continue;
    const coords = feature.geometry?.coordinates;
    if (!coords) continue;
    const [lng, lat] = coords;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;

    staticRows.push({
      poiId,
      lng,
      lat,
      payload: {
        coordinates: [lng, lat] as [number, number],
        name: props.title || props.name || "Parking",
        parkingType: "garage",
        capacity: typeof props.capacity === "number" ? props.capacity : undefined,
        fee: "paid",
        access: "public",
      },
    });

    const hasLiveAvailability = typeof props.free === "number" || !!props.openingState;
    if (hasLiveAvailability) {
      live.set(poiId, {
        asOf: props.timestamp || fallbackAsOf,
        freeSpaces: typeof props.free === "number" ? props.free : undefined,
        state: mapOpeningState(props.openingState),
        trend: mapTrend(props.trend),
      });
    }
  }

  return { static: staticRows, live };
};
