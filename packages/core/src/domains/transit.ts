import type { BBox } from "../types/geometry";
import type {
  Departure,
  ServiceAlert,
  TransitRoute,
  TransitStop,
  TripPlan,
  VehiclePosition,
} from "../types/transit";

export interface TransitProviderCapabilities {
  stops: boolean;
  departures: boolean;
  arrivals: boolean;
  search: boolean;
  tripPlanning: boolean;
  alerts: boolean;
  vehicles: boolean;
}

export interface TripPlanParams {
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
  departureTime?: string;
  arrivalTime?: string;
  modes?: string[];
}

export interface AlertParams {
  stopId?: string;
  routeId?: string;
}

export interface TransitProvider {
  readonly id: string;
  readonly prefix: string;
  readonly coverage: { bbox: BBox };
  readonly priority: number;
  readonly capabilities: TransitProviderCapabilities;

  getStopsNearby?(lat: number, lng: number, radiusMeters: number): Promise<TransitStop[]>;
  getDepartures?(stopId: string, minutes: number): Promise<Departure[]>;
  getArrivals?(stopId: string, minutes: number): Promise<Departure[]>;
  searchByName?(query: string, limit: number): Promise<TransitStop[]>;
  getStop?(stopId: string): Promise<TransitStop | null>;
  getStopPlatforms?(stopId: string): Promise<TransitStop[]>;
  getStopTimetable?(stopId: string, date: string): Promise<Departure[]>;
  getRoutesForStop?(stopId: string): Promise<TransitRoute[]>;
  getRoutesInBbox?(bbox: BBox): Promise<TransitRoute[]>;
  getRoute?(routeId: string): Promise<TransitRoute | null>;
  getRouteStops?(routeId: string, hintStopId?: string): Promise<TransitStop[]>;
  planTrip?(params: TripPlanParams): Promise<TripPlan | null>;
  getAlerts?(bbox: BBox): Promise<ServiceAlert[]>;
  getStopAlerts?(stopId: string): Promise<ServiceAlert[]>;
  getRouteAlerts?(routeId: string): Promise<ServiceAlert[]>;
  getVehiclePositions?(routeId: string): Promise<VehiclePosition[]>;
  getVehicleRadar?(bbox: BBox): Promise<VehiclePosition[]>;
  getVehicleJourney?(vehicleId: string, fallbackIds?: string[]): Promise<unknown>;
  getFacilities?(stopId: string): Promise<unknown>;
  getReachableStops?(
    lat: number,
    lng: number,
    maxMinutes: number,
    modes?: string[],
  ): Promise<TransitStop[]>;
}
