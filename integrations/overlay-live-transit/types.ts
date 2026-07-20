import type { ServiceAlert, TransportMode, VehiclePosition } from "@openmapx/mobility-core/transit";

export interface LiveTransitVehicle extends VehiclePosition {
  sourceId: string;
  mode: TransportMode;
  displayLabel: string;
  secondaryLabel?: string;
  codespaceId?: string;
  /**
   * How the position was derived. Real-time feeds (Entur/DB-RIS/SIRI) report an
   * `observed` GPS fix; MOTIS `map/trips` yields a schedule-based (realtime-aware)
   * `interpolated` estimate. Undefined is treated as `observed`. The overlay
   * renders interpolated vehicles with a distinct style and prefers an observed
   * fix over an interpolated one for the same trip.
   */
  positionKind?: "observed" | "interpolated";
}

export interface LiveTransitSnapshot {
  vehicles: LiveTransitVehicle[];
  alerts: ServiceAlert[];
}
