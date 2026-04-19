import type { IntegrationContext } from "@openmapx/core";
import * as tfl from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  tfl.setTflApiKey(ctx.config.apiKey as string | undefined);
  ctx.registerProvider("transit", {
    id: "transit-tfl",
    prefix: "tfl:",
    coverage: { bbox: [-0.51, 51.28, 0.33, 51.69] },
    priority: 1,
    getStopsNearby: (lat: number, lng: number, radiusMeters: number) =>
      tfl.getStops(lat, lng, radiusMeters),
    getStop: (id: string) => tfl.getStop(id),
    getDepartures: (id: string, min: number) => tfl.getDepartures(id, min),
    searchByName: (q: string, limit: number) => tfl.searchByName(q, limit),
    async getAlerts() {
      return tfl.getAlerts();
    },
    async getStopAlerts(id: string) {
      return tfl.getStopAlerts(id);
    },
    async getRouteAlerts(id: string) {
      return tfl.getRouteAlerts(id);
    },
  });
}
