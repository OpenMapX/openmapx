import type {
  Departure,
  ServiceAlert,
  TransitRoute,
  TransitStop,
  TripPlan,
  VehiclePosition,
} from "@openmapx/core";
import { providerHealth } from "./health";
import type { BBox } from "./types";

export interface TransitProviderImpl {
  readonly id: string;
  readonly prefix: string;
  readonly coverage: { bbox: BBox };
  readonly priority: number;

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
  getAlerts?(bbox: BBox): Promise<ServiceAlert[]>;
  getStopAlerts?(stopId: string): Promise<ServiceAlert[]>;
  getRouteAlerts?(routeId: string): Promise<ServiceAlert[]>;
  getVehiclePositions?(routeId: string): Promise<VehiclePosition[]>;
  getVehicleRadar?(bbox: BBox): Promise<VehiclePosition[]>;
  getVehicleJourney?(vehicleId: string, fallbackIds?: string[]): Promise<unknown>;
  getFacilities?(stopId: string): Promise<unknown>;
  planTrip?(params: {
    from: { lat: number; lng: number };
    to: { lat: number; lng: number };
    departureTime?: string;
    arrivalTime?: string;
    modes?: string[];
  }): Promise<TripPlan | null>;
  getReachableStops?(
    lat: number,
    lng: number,
    maxMinutes: number,
    modes?: string[],
  ): Promise<TransitStop[]>;
}

function bboxesOverlap(a: BBox, b: BBox): boolean {
  return a[2] > b[0] && b[2] > a[0] && a[3] > b[1] && b[3] > a[1];
}

const EARTH_RADIUS = 6_371_000;

export function bboxToCenter(bbox: BBox): { lat: number; lng: number; radiusMeters: number } {
  const [west, south, east, north] = bbox;
  const lat = (south + north) / 2;
  const lng = (west + east) / 2;
  const latDiff = Math.abs(north - south);
  const lngDiff = Math.abs(east - west);
  const latMeters = (latDiff * Math.PI * EARTH_RADIUS) / 180;
  const lngMeters = (lngDiff * Math.PI * EARTH_RADIUS * Math.cos((lat * Math.PI) / 180)) / 180;
  const halfDiag = Math.sqrt(latMeters * latMeters + lngMeters * lngMeters) / 2;
  return { lat, lng, radiusMeters: halfDiag * 1.1 };
}

export class TransitOrchestrator {
  private providers = new Map<string, TransitProviderImpl>();
  private prefixMap = new Map<string, TransitProviderImpl>();

  register(provider: TransitProviderImpl): void {
    // First registered wins for a given prefix (hand-crafted load before dynamic)
    if (this.prefixMap.has(provider.prefix)) return;
    this.providers.set(provider.id, provider);
    this.prefixMap.set(provider.prefix, provider);
  }

  unregister(id: string): void {
    const p = this.providers.get(id);
    if (p) {
      this.providers.delete(id);
      this.prefixMap.delete(p.prefix);
    }
  }

  getAll(): TransitProviderImpl[] {
    return Array.from(this.providers.values());
  }

  resolveByPrefix(id: string): TransitProviderImpl | null {
    for (const [prefix, provider] of this.prefixMap) {
      if (id.startsWith(prefix)) return provider;
    }
    return null;
  }

  /** Returns the priority for a provider name (lower = better). Useful for dedup. */
  getProviderPriority(providerName: string): number {
    for (const p of this.providers.values()) {
      if (p.id === providerName || providerName.startsWith(p.prefix.replace(":", "")))
        return p.priority;
    }
    return 100; // unknown providers get low priority
  }

  getProvidersForBbox(bbox: BBox): TransitProviderImpl[] {
    return Array.from(this.providers.values())
      .filter((p) => bboxesOverlap(bbox, p.coverage.bbox))
      .filter((p) => providerHealth.isHealthy(p.id))
      .sort((a, b) => a.priority - b.priority);
  }

  async getStopsInBbox(bbox: BBox, modes?: string[]): Promise<TransitStop[]> {
    const matching = this.getProvidersForBbox(bbox).filter((p) => p.getStopsNearby);
    const { lat, lng, radiusMeters } = bboxToCenter(bbox);

    const results = await Promise.allSettled(
      matching.map(async (p) => {
        try {
          if (!p.getStopsNearby) return [];
          const stops = await p.getStopsNearby(lat, lng, radiusMeters);
          providerHealth.recordSuccess(p.id);
          return stops;
        } catch {
          providerHealth.recordFailure(p.id);
          return [];
        }
      }),
    );

    const allStops = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));

    if (modes && modes.length > 0) {
      const modeSet = new Set(modes);
      return allStops.filter((s) => s.modes.some((m) => modeSet.has(m)));
    }
    return allStops;
  }

  async getDepartures(stopId: string, minutes: number): Promise<Departure[]> {
    const provider = this.resolveByPrefix(stopId);
    if (!provider?.getDepartures) return [];
    try {
      const result = await provider.getDepartures(stopId, minutes);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return [];
    }
  }

  async getArrivals(stopId: string, minutes: number): Promise<Departure[]> {
    const provider = this.resolveByPrefix(stopId);
    if (!provider?.getArrivals) return [];
    try {
      const result = await provider.getArrivals(stopId, minutes);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return [];
    }
  }

  async getStop(stopId: string): Promise<TransitStop | null> {
    const provider = this.resolveByPrefix(stopId);
    if (!provider?.getStop) return null;
    try {
      const result = await provider.getStop(stopId);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return null;
    }
  }

  async searchByName(query: string, limit: number): Promise<TransitStop[]> {
    const withSearch = Array.from(this.providers.values())
      .filter((p) => p.searchByName && providerHealth.isHealthy(p.id))
      .sort((a, b) => a.priority - b.priority);

    const results = await Promise.allSettled(
      withSearch.map(async (p) => {
        try {
          if (!p.searchByName) return [];
          const stops = await p.searchByName(query, limit);
          providerHealth.recordSuccess(p.id);
          return stops;
        } catch {
          providerHealth.recordFailure(p.id);
          return [];
        }
      }),
    );

    return results.flatMap((r) => (r.status === "fulfilled" ? r.value : [])).slice(0, limit);
  }

  async planTrip(params: {
    from: { lat: number; lng: number };
    to: { lat: number; lng: number };
    departureTime?: string;
    arrivalTime?: string;
    modes?: string[];
  }): Promise<TripPlan | null> {
    const tripBbox: BBox = [
      Math.min(params.from.lng, params.to.lng) - 0.5,
      Math.min(params.from.lat, params.to.lat) - 0.5,
      Math.max(params.from.lng, params.to.lng) + 0.5,
      Math.max(params.from.lat, params.to.lat) + 0.5,
    ];

    const matching = this.getProvidersForBbox(tripBbox).filter((p) => p.planTrip);

    // Waterfall: try each in priority order, return first success
    for (const provider of matching) {
      try {
        const plan = await provider.planTrip?.(params);
        if (plan?.itineraries?.length) {
          providerHealth.recordSuccess(provider.id);
          return plan;
        }
      } catch {
        providerHealth.recordFailure(provider.id);
      }
    }
    return null;
  }

  async getVehicleRadar(bbox: BBox): Promise<VehiclePosition[]> {
    const matching = this.getProvidersForBbox(bbox).filter((p) => p.getVehicleRadar);

    const results = await Promise.allSettled(
      matching.map(async (p) => {
        try {
          if (!p.getVehicleRadar) return [];
          const vehicles = await p.getVehicleRadar(bbox);
          providerHealth.recordSuccess(p.id);
          return vehicles;
        } catch {
          providerHealth.recordFailure(p.id);
          return [];
        }
      }),
    );

    return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  }

  async getAlerts(bbox: BBox): Promise<ServiceAlert[]> {
    const matching = this.getProvidersForBbox(bbox).filter((p) => p.getAlerts);

    const results = await Promise.allSettled(
      matching.map(async (p) => {
        try {
          if (!p.getAlerts) return [];
          const alerts = await p.getAlerts(bbox);
          providerHealth.recordSuccess(p.id);
          return alerts;
        } catch {
          providerHealth.recordFailure(p.id);
          return [];
        }
      }),
    );

    return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  }

  async getStopPlatforms(stopId: string): Promise<TransitStop[]> {
    const provider = this.resolveByPrefix(stopId);
    if (!provider?.getStopPlatforms) return [];
    try {
      const result = await provider.getStopPlatforms(stopId);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return [];
    }
  }

  async getStopTimetable(stopId: string, date: string): Promise<Departure[]> {
    const provider = this.resolveByPrefix(stopId);
    if (!provider?.getStopTimetable) return [];
    try {
      const result = await provider.getStopTimetable(stopId, date);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return [];
    }
  }

  async getRoutesForStop(stopId: string): Promise<TransitRoute[]> {
    const provider = this.resolveByPrefix(stopId);
    if (!provider?.getRoutesForStop) return [];
    try {
      const result = await provider.getRoutesForStop(stopId);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return [];
    }
  }

  async getRoutesInBbox(bbox: BBox): Promise<TransitRoute[]> {
    const matching = this.getProvidersForBbox(bbox).filter((p) => p.getRoutesInBbox);
    const results = await Promise.allSettled(
      matching.map(async (p) => {
        try {
          if (!p.getRoutesInBbox) return [];
          const routes = await p.getRoutesInBbox(bbox);
          providerHealth.recordSuccess(p.id);
          return routes;
        } catch {
          providerHealth.recordFailure(p.id);
          return [];
        }
      }),
    );
    return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  }

  async getRoute(routeId: string): Promise<TransitRoute | null> {
    const provider = this.resolveByPrefix(routeId);
    if (!provider?.getRoute) return null;
    try {
      const result = await provider.getRoute(routeId);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return null;
    }
  }

  async getRouteStops(routeId: string, hintStopId?: string): Promise<TransitStop[]> {
    const provider = this.resolveByPrefix(routeId);
    if (!provider?.getRouteStops) return [];
    try {
      const result = await provider.getRouteStops(routeId, hintStopId);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return [];
    }
  }

  async getStopAlerts(stopId: string): Promise<ServiceAlert[]> {
    const provider = this.resolveByPrefix(stopId);
    if (!provider?.getStopAlerts) return [];
    try {
      const result = await provider.getStopAlerts(stopId);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return [];
    }
  }

  async getRouteAlerts(routeId: string): Promise<ServiceAlert[]> {
    const provider = this.resolveByPrefix(routeId);
    if (!provider?.getRouteAlerts) return [];
    try {
      const result = await provider.getRouteAlerts(routeId);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return [];
    }
  }

  async getVehiclePositions(routeId: string): Promise<VehiclePosition[]> {
    const provider = this.resolveByPrefix(routeId);
    if (!provider?.getVehiclePositions) return [];
    try {
      const result = await provider.getVehiclePositions(routeId);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return [];
    }
  }

  async getVehicleJourney(vehicleId: string, fallbackIds?: string[]): Promise<unknown> {
    const provider = this.resolveByPrefix(vehicleId);
    if (!provider?.getVehicleJourney) return null;
    try {
      const result = await provider.getVehicleJourney(vehicleId, fallbackIds);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return null;
    }
  }

  async getFacilities(stopId: string): Promise<unknown> {
    const provider = this.resolveByPrefix(stopId);
    if (!provider?.getFacilities) return null;
    try {
      const result = await provider.getFacilities(stopId);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return null;
    }
  }

  async getReachableStops(
    lat: number,
    lng: number,
    maxMinutes: number,
    modes?: string[],
  ): Promise<TransitStop[]> {
    // Use all healthy providers and merge results
    const allProviders = Array.from(this.providers.values()).filter(
      (p) => p.getReachableStops && providerHealth.isHealthy(p.id),
    );

    const results = await Promise.allSettled(
      allProviders.map(async (p) => {
        try {
          if (!p.getReachableStops) return [];
          const stops = await p.getReachableStops(lat, lng, maxMinutes, modes);
          providerHealth.recordSuccess(p.id);
          return stops;
        } catch {
          providerHealth.recordFailure(p.id);
          return [];
        }
      }),
    );
    return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  }

  getHealthStatus(): Record<string, { healthy: boolean; failures: number }> {
    return providerHealth.getStatus();
  }
}

/** Global orchestrator instance */
export const transitOrchestrator = new TransitOrchestrator();
