import type { TransitStop } from "./transit.js";

export const TRANSIT_WALK_PROFILE = {
  id: "foot-1.2-cap-900-v1",
  pedestrianProfile: "FOOT",
  speedMetresPerSecond: 1.2,
  accessSeconds: 900,
  egressSeconds: 900,
  directSeconds: 900,
} as const;

export const MAX_TRANSIT_REACHABILITY_THRESHOLDS = 4;
export const MAX_TRANSIT_REACHABILITY_DESTINATIONS = 200;
export const MAX_TRANSIT_REACHABILITY_MINUTES = 90;

export type TransitReachabilitySource = "self-hosted-motis" | "transitous";

export type TransitExactPointCheckReason =
  | "available"
  | "operator-disabled"
  | "hosted-source"
  | "street-routing-disabled"
  | "endpoint-unverified"
  | "runtime-unhealthy";

export interface TransitReachabilityCapabilities {
  estimatedSurface: boolean;
  exactPointChecks: boolean;
  exactPointCheckReason: TransitExactPointCheckReason;
  maxDestinationsPerBatch: number | null;
  maxTravelTimeMinutes: number;
  datasetEpoch: string | null;
}

export interface TransitReachabilitySeed {
  lng: number;
  lat: number;
  arrivalSeconds: number;
  /** Retained for the optional reachable-stop diagnostic overlay. */
  stop?: Pick<TransitStop, "id" | "name" | "modes" | "provider">;
}

export interface TransitReachabilityQuery {
  origin: { lng: number; lat: number };
  queryTime: string;
  direction: "depart-at";
  thresholdsMinutes: number[];
  transitModes?: string[];
  walkProfileId: typeof TRANSIT_WALK_PROFILE.id;
}

export type TransitReachabilitySurfaceRequest = TransitReachabilityQuery;

export interface TransitReachabilityThinning {
  originalSeedCount: number;
  seedCount: number;
  gridMetres: number;
}

export interface TransitReachabilitySurface {
  queryTime: string;
  source: TransitReachabilitySource;
  capabilities: TransitReachabilityCapabilities;
  seeds: TransitReachabilitySeed[];
  thinning: TransitReachabilityThinning;
}

export interface TransitReachabilityDestination {
  id: string;
  lng: number;
  lat: number;
}

export interface TransitReachabilityCheckRequest extends TransitReachabilityQuery {
  destinations: TransitReachabilityDestination[];
}

export interface TransitReachabilityDestinationResult {
  id: string;
  durationSeconds: number | null;
  reachable: boolean;
}

export interface TransitReachabilityCheckResult {
  queryTime: string;
  results: TransitReachabilityDestinationResult[];
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("request must be an object");
  }
  return value as Record<string, unknown>;
}

function coordinate(value: unknown, name: "lat" | "lng"): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  const limit = name === "lat" ? 90 : 180;
  if (value < -limit || value > limit) throw new RangeError(`${name} is outside WGS84 bounds`);
  return value;
}

function isoInstant(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("queryTime is required");
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError("queryTime must be ISO 8601");
  return new Date(milliseconds).toISOString();
}

function thresholds(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_TRANSIT_REACHABILITY_THRESHOLDS
  ) {
    throw new RangeError("thresholdsMinutes must contain one to four values");
  }
  const normalized = value.map((minutes) => {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_TRANSIT_REACHABILITY_MINUTES) {
      throw new RangeError(
        `threshold must be an integer from 1 to ${MAX_TRANSIT_REACHABILITY_MINUTES}`,
      );
    }
    return minutes as number;
  });
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index] <= normalized[index - 1]) {
      throw new RangeError("thresholdsMinutes must be sorted and unique");
    }
  }
  return normalized;
}

function modes(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError("transitModes must be an array");
  const normalized = value.map((mode) => {
    if (typeof mode !== "string" || !/^[A-Z][A-Z_]*$/.test(mode)) {
      throw new TypeError("transitModes contains an invalid mode");
    }
    return mode;
  });
  return [...new Set(normalized)].sort();
}

function query(value: unknown): TransitReachabilityQuery {
  const input = record(value);
  const origin = record(input.origin);
  if (input.direction !== "depart-at") throw new TypeError("only depart-at is supported");
  if (input.walkProfileId !== TRANSIT_WALK_PROFILE.id) {
    throw new TypeError("unsupported walkProfileId");
  }
  return {
    origin: { lng: coordinate(origin.lng, "lng"), lat: coordinate(origin.lat, "lat") },
    queryTime: isoInstant(input.queryTime),
    direction: "depart-at",
    thresholdsMinutes: thresholds(input.thresholdsMinutes),
    transitModes: modes(input.transitModes),
    walkProfileId: TRANSIT_WALK_PROFILE.id,
  };
}

export function parseTransitReachabilitySurfaceRequest(
  value: unknown,
): TransitReachabilitySurfaceRequest {
  return query(value);
}

export function parseTransitReachabilityCheckRequest(
  value: unknown,
): TransitReachabilityCheckRequest {
  const input = record(value);
  const parsedQuery = query(input);
  if (
    !Array.isArray(input.destinations) ||
    input.destinations.length > MAX_TRANSIT_REACHABILITY_DESTINATIONS
  ) {
    throw new RangeError(
      `destinations must contain at most ${MAX_TRANSIT_REACHABILITY_DESTINATIONS} values`,
    );
  }
  const seen = new Set<string>();
  const destinations = input.destinations.map((raw) => {
    const destination = record(raw);
    if (typeof destination.id !== "string" || !destination.id || destination.id.length > 256) {
      throw new TypeError("destination id must be a non-empty string of at most 256 characters");
    }
    if (seen.has(destination.id)) throw new TypeError("destination ids must be unique");
    seen.add(destination.id);
    return {
      id: destination.id,
      lng: coordinate(destination.lng, "lng"),
      lat: coordinate(destination.lat, "lat"),
    };
  });
  return { ...parsedQuery, destinations };
}
