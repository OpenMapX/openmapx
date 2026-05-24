import type { PoiRow } from "@openmapx/poi-source-registry";

/**
 * Københavns Kommune WFS p_hus parser.
 *
 * Static-only GeoJSON FeatureCollection. The numeric `id` field on each
 * feature is the stable per-garage key (pre-migration id was `copenhagen:${id}`).
 */

interface CopenhagenFeatureProperties {
  id: number;
  vejkode: string | null;
  vejnavn: string | null;
  husnr: string | null;
  postdistrikt: string | null;
  antal_pladser: number | null;
  ejer_status: string | null;
  p_hus_type: string | null;
  type_beskrivelse: string | null;
  opret_dato: string | null;
  ret_dato: string | null;
  bemaerkning: string | null;
  ogc_fid: string | null;
}

interface CopenhagenGeoJsonResponse {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: { type: "Point"; coordinates: [number, number] };
    properties: CopenhagenFeatureProperties;
  }>;
}

export function parseCopenhagenDkStatic(buffer: Buffer): PoiRow[] {
  const text = buffer.toString("utf-8");
  let data: CopenhagenGeoJsonResponse;
  try {
    data = JSON.parse(text) as CopenhagenGeoJsonResponse;
  } catch {
    return [];
  }
  if (!Array.isArray(data?.features)) return [];

  const out: PoiRow[] = [];
  for (const feature of data.features) {
    const props = feature.properties;
    if (!props || props.id == null) continue;
    const coords = feature.geometry?.coordinates;
    const lng = coords?.[0];
    const lat = coords?.[1];
    if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) continue;

    const capacity =
      props.antal_pladser != null && props.antal_pladser > 0 ? props.antal_pladser : undefined;

    let name = "Parking";
    if (props.bemaerkning) {
      name = props.bemaerkning;
    } else if (props.vejnavn) {
      name = props.husnr ? `${props.vejnavn} ${props.husnr}` : props.vejnavn;
    }

    let address: string | undefined;
    if (props.vejnavn) {
      const street = props.husnr ? `${props.vejnavn} ${props.husnr}` : props.vejnavn;
      address = props.postdistrikt ? `${street}, ${props.postdistrikt}` : street;
    }

    const access: "public" | "private" = props.ejer_status === "Privat" ? "private" : "public";

    out.push({
      poiId: String(props.id),
      lng,
      lat,
      payload: {
        coordinates: [lng, lat] as [number, number],
        name,
        capacity,
        parkingType: deriveParkingType(props.type_beskrivelse),
        fee: "unknown",
        access,
        address,
      },
    });
  }
  return out;
}

function deriveParkingType(typeBeskrivelse: string | null): "garage" | "underground" {
  if (!typeBeskrivelse) return "garage";
  const lower = typeBeskrivelse.toLowerCase();
  if (lower.includes("kælder") || lower.includes("kaelder")) return "underground";
  return "garage";
}
