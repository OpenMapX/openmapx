import type {
  Departure,
  ServiceAlert,
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
  readonly coverage: { bbox: [number, number, number, number] };
  readonly priority: number;
  readonly capabilities: TransitProviderCapabilities;

  getStopsNearby?(lat: number, lng: number, radiusMeters: number): Promise<TransitStop[]>;
  getDepartures?(stopId: string, minutes: number): Promise<Departure[]>;
  getArrivals?(stopId: string, minutes: number): Promise<Departure[]>;
  searchByName?(query: string, limit: number): Promise<TransitStop[]>;
  planTrip?(params: TripPlanParams): Promise<TripPlan | null>;
  getAlerts?(params: AlertParams): Promise<ServiceAlert[]>;
  getVehiclePositions?(bbox: [number, number, number, number]): Promise<VehiclePosition[]>;
}
