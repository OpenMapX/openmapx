import type { BBox } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { MobilityResult } from "@openmapx/mobility-core/result";
import type { ServiceAlert, VehiclePosition } from "@openmapx/mobility-core/transit";
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
 * Per-provider trip update delta. Intentionally `unknown`: each realtime
 * provider's source shape differs (MOTIS returns a full `Itinerary`, an
 * Entur SIRI-ET adapter would return a SIRI fragment, etc.). Consumers
 * narrow on a provider-specific type guard.
 */
export type TripUpdate = unknown;

export interface RealtimeProvider {
  readonly id: string;
  readonly coverage: { bbox: BBox } | { all: true };
  readonly priority: number;
  readonly capabilities: RealtimeCapabilities;
  readonly attribution: Attribution[];

  getVehiclePositions?(bbox: BBox): Promise<MobilityResult<VehiclePosition[]>>;
  getAlertsForStop?(stopId: string): Promise<MobilityResult<ServiceAlert[]>>;
  getAlertsForRoute?(routeId: string): Promise<MobilityResult<ServiceAlert[]>>;
  getAlertsForBbox?(bbox: BBox): Promise<MobilityResult<ServiceAlert[]>>;
  getTripUpdate?(tripId: string): Promise<MobilityResult<TripUpdate | null>>;

  /** Optional. Providers that have no meaningful self-check may omit this
   *  and rely on `ctx.registerHealthCheck()` declared at integration setup. */
  healthCheck?(): Promise<HealthCheckResult>;
}
