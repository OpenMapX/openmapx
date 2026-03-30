import type { IntegrationContext } from "@openmapx/core";
import * as ch from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerProvider("transit", {
    id: "transit-opendata-ch",
    prefix: "ch:",
    coverage: { bbox: [5.96, 45.82, 10.49, 47.81] },
    priority: 1,
    getStopsNearby: (lat: number, lng: number) => ch.getStops(lat, lng),
    getDepartures: (id: string, min: number) => ch.getDepartures(id, min),
    getArrivals: (id: string, min: number) => ch.getArrivals(id, min),
    searchByName: (q: string, limit: number) => ch.searchByName(q, limit),
    async planTrip(params: {
      from: { lat: number; lng: number };
      to: { lat: number; lng: number };
      departureTime?: string;
    }) {
      const now = new Date();
      const date = params.departureTime?.slice(0, 10) ?? now.toISOString().slice(0, 10);
      const time = params.departureTime?.slice(11, 19) ?? now.toISOString().slice(11, 19);
      return ch.planConnections(
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
