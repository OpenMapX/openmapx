import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
/**
 * Wuppertal car-sharing open data client.
 * GeoJSON with stations from Cambio, Flinkster, and RUHRAUTOE.
 * https://ckan.open.nrw.de/dataset/carsharing-stationen-wuppertal-w
 */

import type { LngLat } from "@openmapx/core";
import type { SharedMobilityStation } from "@openmapx/mobility-core/shared-mobility";
import { createStaticCarSharingClient } from "./static-car-sharing-client.js";

interface DeNwWuppertalFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    NAME_STAT?: string;
    ADRESSE?: string;
    ORT?: string;
    ANZ_FAHRZ?: number;
    ANBIETER?: string;
    KLASSEN_FZ?: string;
    URL?: string;
  };
}

interface DeNwWuppertalGeoJSON {
  type: "FeatureCollection";
  features: DeNwWuppertalFeature[];
}

function parseAddress(
  adresse?: string,
  ort?: string,
): { street?: string; city?: string; postcode?: string } | undefined {
  if (!adresse && !ort) return undefined;
  // ORT format: "42117 Wuppertal" → postcode + city
  let city: string | undefined;
  let postcode: string | undefined;
  if (ort) {
    const match = ort.match(/^(\d{5})\s+(.+)$/);
    if (match) {
      postcode = match[1];
      city = match[2];
    } else {
      city = ort;
    }
  }
  return { street: adresse, city, postcode };
}

export function parseDeNwWuppertalGeoJson(body: string): SharedMobilityStation[] {
  const geojson = JSON.parse(body) as DeNwWuppertalGeoJSON;
  const stations: SharedMobilityStation[] = [];

  for (const feature of geojson.features) {
    const coords = feature.geometry?.coordinates;
    if (!coords || coords.length < 2) continue;

    const [lng, lat] = coords;
    const props = feature.properties;
    const name = props.NAME_STAT || "Station";

    stations.push({
      id: `de-nw-wuppertal/${lng.toFixed(5)},${lat.toFixed(5)}`,
      name,
      coordinates: [lng, lat] as LngLat,
      // ANZ_FAHRZ counts the vehicles stationed here, not those free to book now.
      capacity: props.ANZ_FAHRZ,
      operator: props.ANBIETER || undefined,
      vehicleTypes: ["car"],
      sources: ["de-nw-wuppertal"],
      address: parseAddress(props.ADRESSE, props.ORT),
      website: props.URL || undefined,
      vehicleClassNames: props.KLASSEN_FZ
        ? props.KLASSEN_FZ.split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
    });
  }

  return stations;
}

export const deNwWuppertalClient = createStaticCarSharingClient({
  id: "de-nw-wuppertal",
  name: "Wuppertal Open Data",
  url: "https://daten.wuppertal.de/Transport_Verkehr/Carsharing_EPSG4326_JSON.json",
  regions: [{ center: [7.18, 51.26] as LngLat, radiusKm: 15 }],
  attribution: {
    label: "Stadt Wuppertal",
    url: "https://www.offenedaten-wuppertal.de",
    licensing: licensingFromDeclaration(
      "CC-BY-4.0",
      "https://creativecommons.org/licenses/by/4.0/",
    ),
  },
  parse: parseDeNwWuppertalGeoJson,
});
