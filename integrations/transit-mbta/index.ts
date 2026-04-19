import type { IntegrationContext } from "@openmapx/core";
import * as mbta from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  mbta.setMbtaApiKey(ctx.config.apiKey as string | undefined);
  ctx.registerProvider("transit", {
    id: "transit-mbta",
    prefix: "mb:",
    coverage: { bbox: [-71.9, 41.3, -69.9, 42.9] },
    priority: 1,
    async getStopsNearby(lat: number, lng: number, radiusMeters: number) {
      return mbta.getStops(lat, lng, radiusMeters);
    },
    getStop: (id: string) => mbta.getStop(id),
    getDepartures: (id: string, min: number) => mbta.getDepartures(id, min),
    async getVehiclePositions(routeId: string) {
      return mbta.getVehiclePositions(routeId);
    },
    async getFacilities(stopId: string) {
      return mbta.getFacilities(stopId);
    },
  });
}
