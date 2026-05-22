import type { ServiceAlert, TransportMode, VehiclePosition } from "@openmapx/mobility-core/transit";

export interface LiveTransitVehicle extends VehiclePosition {
  sourceId: string;
  mode: TransportMode;
  displayLabel: string;
  secondaryLabel?: string;
  codespaceId?: string;
}

export interface LiveTransitSnapshot {
  vehicles: LiveTransitVehicle[];
  alerts: ServiceAlert[];
}
