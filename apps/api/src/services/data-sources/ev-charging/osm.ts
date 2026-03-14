import type { BoundingBox } from "@openmapx/core";

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

export interface OsmChargingStation {
  id: number;
  lat: number;
  lon: number;
  tags: Record<string, string>;
}

interface OverpassElement {
  type: string;
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

/** Fetch a single OSM node by ID. */
export async function getOsmChargingNode(nodeId: number): Promise<OsmChargingStation | null> {
  const query = `[out:json][timeout:10];node(${nodeId});out body;`;

  try {
    const res = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
    });

    if (!res.ok) return null;

    const data = (await res.json()) as OverpassResponse;
    const el = data.elements?.[0];
    if (!el) return null;

    return { id: el.id, lat: el.lat, lon: el.lon, tags: el.tags ?? {} };
  } catch {
    return null;
  }
}

export async function searchOsmCharging(bbox: BoundingBox): Promise<OsmChargingStation[]> {
  const query = `[out:json][timeout:25];node["amenity"="charging_station"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});out body;`;

  try {
    const res = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
    });

    if (!res.ok) return [];

    const data = (await res.json()) as OverpassResponse;

    return (data.elements ?? []).map((el) => ({
      id: el.id,
      lat: el.lat,
      lon: el.lon,
      tags: el.tags ?? {},
    }));
  } catch {
    return [];
  }
}
