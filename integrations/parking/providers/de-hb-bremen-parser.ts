import type { PoiRow } from "@openmapx/poi-source-registry";

/**
 * VMZ Bremen parking GeoJSON parser.
 *
 * Static catalogue (`vmz.bremen.de/geojson/parking.geojson`) — point geometry
 * per facility, no live availability inside this feed. `id` is the stable
 * `poi-vmz-hb-<n>` slug; `externalId` is the operator-side key (kept in
 * payload for parity with the operator portal).
 */

interface BremenFeatureProperties {
  id?: string;
  name?: string;
  title?: string;
  externalId?: string | null;
  height_restriction?: string;
  permanentLink?: string;
  detailsUrl?: string;
}

interface BremenFeature {
  type: "Feature";
  id?: string;
  geometry?: { type: "Point"; coordinates: [number, number] };
  properties?: BremenFeatureProperties;
}

interface BremenGeoJsonResponse {
  type?: "FeatureCollection";
  features?: BremenFeature[];
}

/**
 * VMZ Bremen states height limits like "1,95 m" or "2,00 m" — German decimal
 * comma + literal " m" suffix. Returns centimeters to match the ParkingFacility
 * `maxHeight` contract.
 */
function parseHeightRestriction(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const normalised = raw.replace(",", ".").replace(/[^\d.]/g, "");
  const meters = Number.parseFloat(normalised);
  if (!Number.isFinite(meters) || meters <= 0) return undefined;
  return Math.round(meters * 100);
}

export function parseDeHbBremenStatic(buffer: Buffer): PoiRow[] {
  let data: BremenGeoJsonResponse;
  try {
    data = JSON.parse(buffer.toString("utf-8")) as BremenGeoJsonResponse;
  } catch {
    return [];
  }
  if (!Array.isArray(data?.features)) return [];

  const out: PoiRow[] = [];
  for (const feature of data.features) {
    const props = feature.properties ?? {};
    const poiId = feature.id ?? props.id;
    if (!poiId) continue;
    if (props.externalId === null && !poiId.startsWith("poi-vmz-")) continue;
    const coords = feature.geometry?.coordinates;
    if (!coords) continue;
    const [lng, lat] = coords;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;

    out.push({
      poiId,
      lng,
      lat,
      payload: {
        coordinates: [lng, lat] as [number, number],
        name: props.title || props.name || "Parking",
        parkingType: "garage",
        fee: "paid",
        access: "public",
        maxHeight: parseHeightRestriction(props.height_restriction),
        url: props.permanentLink ?? props.detailsUrl ?? undefined,
        // VMZ's operator-side id (e.g. "PH10", "Ski_BRILL"). Helps operators
        // cross-reference our display id with the city's PLS.
        sourceUid: props.externalId ?? undefined,
      },
    });
  }
  return out;
}
