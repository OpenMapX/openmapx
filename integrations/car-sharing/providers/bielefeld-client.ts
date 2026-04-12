/**
 * Bielefeld car-sharing open data client.
 * WFS/CSV with Cambio stations including booking URLs, capacity, and descriptions.
 * https://ckan.open.nrw.de/dataset/carsharing-bi
 */

import type { LngLat } from "@openmapx/core";
import type { SharedMobilityStation } from "@openmapx/integration-shared-mobility/types";
import { createStaticCarSharingClient } from "./static-car-sharing-client.js";

const WFS_URL =
  "https://www.bielefeld01.de/md/WFS/carsharing/01?SERVICE=WFS&VERSION=1.1.0&REQUEST=GetFeature&TYPENAME=carsharing_p&SRSNAME=EPSG:4326&OUTPUTFORMAT=text/csv";

/** Parse WKT POINT geometry → [lng, lat]. */
function parseWktPoint(wkt: string): [number, number] | null {
  const match = wkt.match(/POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/);
  if (!match) return null;
  return [Number.parseFloat(match[1]), Number.parseFloat(match[2])];
}

/** Parse CSV line respecting quoted fields. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function parse(body: string): SharedMobilityStation[] {
  const lines = body.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];

  // Header: WKT,gid,website,name,addr_street,addr_housenumber,level,capacity,description
  const stations: SharedMobilityStation[] = [];

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    if (fields.length < 9) continue;

    const [wkt, gid, website, name, street, houseNumber, _level, capacityStr, description] = fields;
    const coords = parseWktPoint(wkt);
    if (!coords) continue;

    const [lng, lat] = coords;
    const capacity = capacityStr ? Number.parseInt(capacityStr, 10) : undefined;
    const fullStreet = [street, houseNumber].filter(Boolean).join(" ");

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
