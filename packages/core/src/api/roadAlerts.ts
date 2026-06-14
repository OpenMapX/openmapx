import type { RoadAlertType } from "../navigation/alerts";
import { apiClient } from "./client";
import { API_ENDPOINTS } from "./endpoints";

/** An approach alert before it is projected onto a route (raw OSM position). */
export interface RawRoadAlert {
  id: string;
  type: RoadAlertType;
  lat: number;
  lng: number;
  speedLimitKmh?: number;
}

export interface AlertBBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/**
 * Fetch approach alerts (speed cameras, level crossings, stop signs, traffic
 * calming) within a bounding box. Returns [] on any error or for a corridor too
 * large for the server to query — this is an optional layer that must never
 * break navigation.
 */
export async function fetchRoadAlerts(bbox: AlertBBox): Promise<RawRoadAlert[]> {
  try {
    const res = await apiClient.get<{ alerts: RawRoadAlert[] }>(API_ENDPOINTS.navigationAlerts, {
      bbox: `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`,
    });
    return res.alerts ?? [];
  } catch {
    return [];
  }
}
