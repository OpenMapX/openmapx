/**
 * MOTIS HTTP API endpoint builders, centralised so a server version bump is a
 * single edit rather than a hunt across motis-health, promote, and the live
 * canary test. Paths are for MOTIS 2.x (verified against 2.10.2):
 *   - `/api/v1/health`      — liveness gate
 *   - `/api/v1/map/initial` — bounded initial map view (NOT `/api/v1/initial`)
 *   - `/api/v1/map/stops`   — stops in a bbox (NOT `/api/v1/stops`)
 *   - `/api/v1/plan`        — routing between two coordinates
 */

export interface BboxQuery {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

export interface PlanQuery {
  fromLat: number;
  fromLng: number;
  toLat: number;
  toLng: number;
}

export function healthUrl(base: string): string {
  return `${base}/api/v1/health`;
}

export function mapInitialUrl(base: string): string {
  return `${base}/api/v1/map/initial`;
}

export function mapStopsUrl(base: string, q: BboxQuery): string {
  return `${base}/api/v1/map/stops?min=${q.minLat},${q.minLng}&max=${q.maxLat},${q.maxLng}`;
}

export function planUrl(base: string, q: PlanQuery): string {
  return `${base}/api/v1/plan?fromPlace=${q.fromLat},${q.fromLng}&toPlace=${q.toLat},${q.toLng}`;
}
