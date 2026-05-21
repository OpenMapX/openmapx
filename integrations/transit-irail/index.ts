import type { IntegrationContext } from "@openmapx/integration-framework";
import * as irail from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerProvider("transit", {
    id: "transit-irail",
    prefix: "ir:",
    coverage: { bbox: [2.54, 49.49, 5.92, 51.51] },
    priority: 1,

    getStopsNearby: (lat: number, lng: number, radiusMeters: number) =>
      irail.getStops(lat, lng, radiusMeters),
    getStop: (stopId: string) => irail.getStopById(stopId),
    getDepartures: (stopId: string, minutes: number) => irail.getDepartures(stopId, minutes),
    getArrivals: (stopId: string, minutes: number) => irail.getArrivals(stopId, minutes),
    searchByName: (query: string, limit: number) => irail.searchByName(query, limit),
    async getVehicleJourney(vehicleId: string) {
      return irail.getVehicleJourney(vehicleId);
    },
    async planTrip(params: {
      from: { lat: number; lng: number };
      to: { lat: number; lng: number };
      departureTime?: string;
    }) {
      const now = new Date();
      const date = params.departureTime?.slice(0, 10) ?? now.toISOString().slice(0, 10);
      const time = params.departureTime?.slice(11, 19) ?? now.toISOString().slice(11, 19);
      return irail.planConnections(
        params.from.lat,
        params.from.lng,
        params.to.lat,
        params.to.lng,
        date,
        time,
      );
    },
  });
}
