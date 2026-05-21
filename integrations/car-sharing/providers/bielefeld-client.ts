/**
 * Bielefeld car-sharing open data client.
 * WFS/CSV with Cambio stations including booking URLs, capacity, and descriptions.
 * https://ckan.open.nrw.de/dataset/carsharing-bi
 */

import type { LngLat } from "@openmapx/core";
import { formatAddress } from "@openmapx/integration-geocoding/format-address";
import { parseCsvRecords } from "@openmapx/mobility-formats";
import type { SharedMobilityStation } from "@openmapx/shared-mobility/types";
import { createStaticCarSharingClient } from "./static-car-sharing-client.js";

const WFS_URL =
  "https://www.bielefeld01.de/md/WFS/carsharing/01?SERVICE=WFS&VERSION=1.1.0&REQUEST=GetFeature&TYPENAME=carsharing_p&SRSNAME=EPSG:4326&OUTPUTFORMAT=text/csv";

/** Parse WKT POINT geometry → [lng, lat]. */
function parseWktPoint(wkt: string): [number, number] | null {
  const match = wkt.match(/POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/);
  if (!match) return null;
  return [Number.parseFloat(match[1]), Number.parseFloat(match[2])];
}

function parse(body: string): SharedMobilityStation[] {
  const rows = parseCsvRecords(body);
  if (rows.length === 0) return [];

  const stations: SharedMobilityStation[] = [];

  for (const row of rows) {
    const wkt = row.WKT ?? "";
    const gid = row.gid ?? "";
    const website = row.website ?? "";
    const name = row.name ?? "";
    const street = row.addr_street ?? "";
    const houseNumber = row.addr_housenumber ?? "";
    const capacityStr = row.capacity ?? "";
    const description = row.description ?? "";
    const coords = parseWktPoint(wkt);
    if (!coords) continue;

    const [lng, lat] = coords;
    const capacity = capacityStr ? Number.parseInt(capacityStr, 10) : undefined;
    const fullStreet = formatAddress(
      { road: street, house_number: houseNumber, country_code: "de" },
      { appendCountry: false },
    );

    stations.push({
      id: `bielefeld/${gid}`,
      name: name || "Station",
      coordinates: [lng, lat] as LngLat,
      availableVehicles: capacity ?? 0,
      capacity: Number.isFinite(capacity) ? capacity : undefined,
      operator: "Cambio Bielefeld",
      vehicleTypes: ["car"],
      isActive: true,
      sources: ["bielefeld"],
      address: fullStreet ? { street: fullStreet, city: "Bielefeld", country: "DE" } : undefined,
      website: website || undefined,
      locationHint: description || undefined,
    });
  }

  return stations;
}

export const bielefeldClient = createStaticCarSharingClient({
  id: "bielefeld",
  name: "Bielefeld Open Data",
  url: WFS_URL,
  regions: [{ center: [8.533, 52.03] as LngLat, radiusKm: 15 }],
  attribution: {
    label: "Stadt Bielefeld",
    url: "https://open-data.bielefeld.de",
    license: "ODbL",
    licenseUrl: "https://opendatacommons.org/licenses/odbl/",
  },
  parse,
});
