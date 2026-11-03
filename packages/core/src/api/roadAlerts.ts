import type { RoadAlertType } from "../navigation/alerts";
import type { LngLat } from "../types/geometry";
import { apiClient } from "./client";
import { API_ENDPOINTS } from "./endpoints";

/**
 * A road carrying an approach alert, and the travel directions along it the
 * alert applies to. Directions are relative to the OSM way's digitisation:
 * `forward` traffic follows `line` in index order.
 */
export interface RoadAlertRoad {
  /** OSM way id. */
  wayId: number;
  /** The way's geometry a few tens of metres either side of the alert. */
  line: LngLat[];
  /** Index of the alert's position on this road within `line`. */
  anchorIndex: number;
  forward: boolean;
  backward: boolean;
}

/** An approach alert before it is projected onto a route. */
export interface RawRoadAlert {
  id: string;
  type: RoadAlertType;
  /** The mapped OSM node position. */
  lat: number;
  lng: number;
  speedLimitKmh?: number;
  /** Roads the alert applies to; an alert on none never reaches a route. */
  roads: RoadAlertRoad[];
}

export interface AlertBBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/**
 * Fetch approach alerts (speed cameras, level crossings, stop signs, speed
 * bumps) within a bounding box, each with the roads it applies to. Returns []
 * on any error or for a corridor too large for the server to query — this is
 * an optional layer that must never break navigation. An alert without road
 * information (an answer cached before the server sent it) gets no roads, so
 * it is never attached to a route.
 */
export async function fetchRoadAlerts(bbox: AlertBBox): Promise<RawRoadAlert[]> {
  try {
    const res = await apiClient.get<{ alerts?: RawRoadAlert[] }>(API_ENDPOINTS.navigationAlerts, {
      bbox: `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`,
    });
    return (res.alerts ?? []).map((alert) => ({
      ...alert,
      roads: Array.isArray(alert.roads) ? alert.roads : [],
    }));
  } catch {
    return [];
  }
}
