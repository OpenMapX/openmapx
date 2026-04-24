import type { BBox, ServiceAlert, TransportMode, VehiclePosition } from "@openmapx/core";

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

export interface LiveTransitProvider {
  readonly id: string;
  readonly priority: number;
  readonly coverage?: { bbox: BBox };
  getVehicles(bbox: BBox): Promise<LiveTransitVehicle[]>;
  getAlerts?(bbox: BBox): Promise<ServiceAlert[]>;
}
