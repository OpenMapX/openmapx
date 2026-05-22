import type { BBox } from "@openmapx/core";
import type {
  Departure,
  ServiceAlert,
  TransitStop,
  TripPlan,
  VehicleJourney,
  VehiclePosition,
} from "@openmapx/mobility-core/transit";
import type { RegistryEntry } from "./registry-types";

export interface ProtocolAdapter {
  getStopsNearby(
    entry: RegistryEntry,
    lat: number,
    lng: number,
    radiusMeters: number,
  ): Promise<TransitStop[]>;
  getDepartures(entry: RegistryEntry, stopId: string, minutes: number): Promise<Departure[]>;
  getArrivals(entry: RegistryEntry, stopId: string, minutes: number): Promise<Departure[]>;
  /** Optional: text search for stops by name. */
  searchByName?(entry: RegistryEntry, query: string, limit: number): Promise<TransitStop[]>;
  /** Optional: fetch a single stop by its full prefixed ID. */
  getStopById?(entry: RegistryEntry, stopId: string): Promise<TransitStop | null>;
  /**
   * Optional: fetch service alerts.
   * Pass `stopId` (raw, without prefix) for stop-level alerts,
   * `routeId` (raw, without prefix) for route-level alerts,
   * or neither for all regional alerts.
   */
  getAlerts?(
    entry: RegistryEntry,
    params: { stopId?: string; routeId?: string },
  ): Promise<ServiceAlert[]>;
  /** Optional: fetch a vehicle/trip journey (stop sequence with live data). */
  getTrip?(entry: RegistryEntry, tripId: string): Promise<VehicleJourney | null>;
  /** Optional: fetch live vehicle positions within a bounding box. */
  getVehicleRadar?(entry: RegistryEntry, bbox: BBox): Promise<VehiclePosition[]>;
  planJourney(
    entry: RegistryEntry,
    fromLat: number,
    fromLng: number,
    toLat: number,
    toLng: number,
    date: string,
    time: string,
    arriveBy?: boolean,
    numItineraries?: number,
  ): Promise<TripPlan | null>;
}
