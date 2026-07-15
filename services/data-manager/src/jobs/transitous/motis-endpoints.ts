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

export interface RentalPlanQuery extends PlanQuery {
  providerGroups?: string[];
  providers?: string[];
  formFactors?: string[];
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

export function rentalsUrl(base: string, q: BboxQuery): string {
  const params = new URLSearchParams({
    min: `${q.minLat},${q.minLng}`,
    max: `${q.maxLat},${q.maxLng}`,
    withProviders: "true",
    withStations: "true",
    withVehicles: "true",
    withZones: "true",
  });
  return `${base}/api/v1/rentals?${params}`;
}

/** Build a conservative rental canary: explicit rental scope and no unsafe return overrides. */
export function rentalPlanUrl(base: string, q: RentalPlanQuery): string {
  const params = new URLSearchParams({
    fromPlace: `${q.fromLat},${q.fromLng}`,
    toPlace: `${q.toLat},${q.toLng}`,
    directModes: "RENTAL",
    rentalIgnoreStationReturnConstraints: "false",
    rentalIgnoreVehicleReturnConstraints: "false",
  });
  for (const value of q.providerGroups ?? []) params.append("rentalProviderGroups", value);
  for (const value of q.providers ?? []) params.append("rentalProviders", value);
  for (const value of q.formFactors ?? []) params.append("rentalFormFactors", value);
  return `${base}/api/v1/plan?${params}`;
}
