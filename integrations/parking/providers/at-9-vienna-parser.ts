import type { PoiRow } from "@openmapx/poi-source-registry";

/**
 * Stadt Wien GARAGENOGD WFS parser.
 *
 * Static-only GeoJSON FeatureCollection. `GARAGE_ID` is the stable per-garage
 * key (pre-migration id was `vienna:${GARAGE_ID}`).
 */

interface At9ViennaFeatureProperties {
  OBJECTID: number;
  GARAGE_ID: string;
  BETREIBER: string | null;
  BEZEICHNUNG: string | null;
  PLZ: number | null;
  ORT: string | null;
  ADRESSE: string | null;
  WEBLINK_BETR_DE: string | null;
  WEBLINK_BETR_EN: string | null;
  WEBLINK_WK_DE: string | null;
  WEBLINK_WK_EN: string | null;
  LONGITUDE: number | null;
  LATITUDE: number | null;
  PARK_AND_RIDE: string | null;
  BEHINDERTENPARKPL: string | null;
  SE_ANNO_CAD_DATA: unknown;
}

interface At9ViennaGeoJsonResponse {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: { type: "Point"; coordinates: [number, number] };
    properties: At9ViennaFeatureProperties;
  }>;
}

export function parseAt9ViennaStatic(buffer: Buffer): PoiRow[] {
  const text = buffer.toString("utf-8");
  let data: At9ViennaGeoJsonResponse;
  try {
    data = JSON.parse(text) as At9ViennaGeoJsonResponse;
  } catch {
    return [];
  }
  if (!Array.isArray(data?.features)) return [];

  const out: PoiRow[] = [];
  for (const feature of data.features) {
    const props = feature.properties;
    if (!props?.GARAGE_ID) continue;
    const geomCoords = feature.geometry?.coordinates;
    const lng = geomCoords?.[0] ?? props.LONGITUDE;
    const lat = geomCoords?.[1] ?? props.LATITUDE;
    if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) continue;

    const isPnR = props.PARK_AND_RIDE === "Y";
    const hasDisabled = props.BEHINDERTENPARKPL === "Y";

    let address: string | undefined;
    if (props.ADRESSE) {
      address =
        props.ORT && props.PLZ ? `${props.ADRESSE}, ${props.PLZ} ${props.ORT}` : props.ADRESSE;
    }

    out.push({
      poiId: props.GARAGE_ID,
      lng,
      lat,
      payload: {
        coordinates: [lng, lat] as [number, number],
        name: props.BEZEICHNUNG || "Parking",
        parkingType: "garage",
        // Source encodes "has disabled parking" as a yes/no flag, not a count;
        // pre-migration translated that to disabledSpaces=1 when present.
        disabledSpaces: hasDisabled ? 1 : undefined,
        fee: "unknown",
        access: "public",
        operator: props.BETREIBER ?? undefined,
        address,
        parkAndRide: isPnR || undefined,
        url: props.WEBLINK_BETR_DE ?? props.WEBLINK_WK_DE ?? undefined,
      },
    });
  }
  return out;
}
