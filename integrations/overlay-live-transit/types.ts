import type { LiveTransitVehicle, ServiceAlert } from "@openmapx/mobility-core/transit";

export interface LiveTransitSnapshot {
  vehicles: LiveTransitVehicle[];
  alerts: ServiceAlert[];
}
