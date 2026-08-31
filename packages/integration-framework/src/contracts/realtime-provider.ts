import type { BBox } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { MobilityResult } from "@openmapx/mobility-core/result";
import type { LiveTransitVehicle, ServiceAlert } from "@openmapx/mobility-core/transit";
import type { HealthCheckResult } from "../context.js";

export interface RealtimeCapabilities {
  vehiclePositions: boolean;
  alerts: {
    byStop: boolean;
    byRoute: boolean;
    byBbox: boolean;
  };
  tripUpdates: boolean;
}

/**
 * Realtime delta for a single (trip, stop) pair. Consumed by the transit
 * orchestrator to enrich scheduled departures with live `expectedAt` /
 * `delaySeconds` / `canceled` / `platform` overrides.
 *
 * Providers that cannot resolve the given tripId (wrong prefix, unknown
 * trip) return `null` so the orchestrator can move on to the next provider
 * without a thrown error path.
 */
export interface TripUpdate {
  /** Trip id echoed back (with the caller's prefix) so the consumer can correlate. */
  tripId: string;
  /** Realtime expected departure (or arrival) time, ISO 8601. */
  expectedAt?: string;
  /** Positive when late, negative when early. Seconds. */
  delaySeconds?: number;
  /** True iff this trip or the requested stop within it is cancelled. */
  canceled?: boolean;
  /** Realtime platform/track override when the upstream feed exposes one. */
  platform?: string;
}

export interface RealtimeProvider {
  readonly id: string;
  readonly coverage: { bbox: BBox } | { all: true };
  readonly priority: number;
  readonly capabilities: RealtimeCapabilities;
  readonly attribution: Attribution[];

  getVehiclePositions?(bbox: BBox): Promise<MobilityResult<LiveTransitVehicle[]>>;
  getAlertsForStop?(stopId: string): Promise<MobilityResult<ServiceAlert[]>>;
  getAlertsForRoute?(routeId: string): Promise<MobilityResult<ServiceAlert[]>>;
  getAlertsForBbox?(bbox: BBox): Promise<MobilityResult<ServiceAlert[]>>;
  /**
   * Resolve a realtime delta for `tripId`, optionally narrowed to a specific
   * `stopId`. When `stopId` is supplied, the provider should locate that stop
   * within the trip and return its specific delta (departure-based);
   * otherwise the provider returns the trip-level summary (typically the
   * first stop). Return `null` when the trip cannot be resolved by this
   * provider (e.g. id prefix not recognized).
   */
  getTripUpdate?(tripId: string, stopId?: string): Promise<MobilityResult<TripUpdate | null>>;
  /** Optional bounded batch equivalent; results are keyed by requested trip id. */
  getTripUpdates?(
    tripIds: string[],
    stopId?: string,
  ): Promise<MobilityResult<Record<string, TripUpdate | null>>>;

  /** Optional. Providers that have no meaningful self-check may omit this
   *  and rely on `ctx.registerHealthCheck()` declared at integration setup. */
  healthCheck?(): Promise<HealthCheckResult>;
}
