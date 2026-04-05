import type { BoundingBox } from "@openmapx/core";
import { overpassQuerySafe } from "@openmapx/core";

export interface OsmChargingStation {
  id: number;
  lat: number;
  lon: number;
  tags: Record<string, string>;
}

/** Fetch a single OSM node by ID. */
export async function getOsmChargingNode(nodeId: number): Promise<OsmChargingStation | null> {
  const query = `[out:json][timeout:10];node(${nodeId});out body;`;
  const data = await overpassQuerySafe(query, null);
  if (!data) return null;

  const el = data.elements[0];
  if (!el || el.type !== "node") return null;

  return { id: el.id, lat: el.lat, lon: el.lon, tags: el.tags ?? {} };
}

export async function searchOsmCharging(bbox: BoundingBox): Promise<OsmChargingStation[]> {
  const query = `[out:json][timeout:25];node["amenity"="charging_station"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});out body;`;
  const data = await overpassQuerySafe(query, null);
  if (!data) return [];

  return data.elements
    .filter((el): el is Extract<typeof el, { type: "node" }> => el.type === "node")
    .map((el) => ({
      id: el.id,
      lat: el.lat,
      lon: el.lon,
      tags: el.tags ?? {},
    }));
}
