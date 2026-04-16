import type { IntegrationContext } from "@openmapx/core";
import * as dbVendo from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerProvider("transit", {
    id: "transit-db-vendo",
    prefix: "db:",
    coverage: { bbox: [5.87, 47.27, 15.04, 55.06] },
    priority: 2,
    getStopsNearby: (lat: number, lng: number, r: number) => dbVendo.getStopsNearby(lat, lng, r),
    getStop: (id: string) => dbVendo.getStop(id),
    getDepartures: (id: string, min: number) => dbVendo.getDepartures(id, min),
    getArrivals: (id: string, min: number) => dbVendo.getArrivals(id, min),
    searchByName: (q: string, limit: number) => dbVendo.searchByName(q, limit),
    getStopPlatforms: (id: string) => dbVendo.getPlatformStops(id),
    getStopAlerts: (id: string) => dbVendo.getStopAlerts(id),
    async planTrip(params: {
      from: { lat: number; lng: number };
      to: { lat: number; lng: number };
      departureTime?: string;
    }) {
      const now = new Date();
      const date = params.departureTime?.slice(0, 10) ?? now.toISOString().slice(0, 10);
      const time = params.departureTime?.slice(11, 19) ?? now.toISOString().slice(11, 19);
      return dbVendo.planJourney(
        params.from.lat,
        params.from.lng,
        params.to.lat,
        params.to.lng,
        date,
        time,
      );
    },
    async getVehicleJourney(tripId: string) {
      return dbVendo.getTrip(tripId);
    },
    getLegGeometry: (tripId: string, fromStopId?: string, toStopId?: string) =>
      dbVendo.getLegGeometry(tripId, fromStopId, toStopId),
  });
}
