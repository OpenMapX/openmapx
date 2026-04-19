import type { IntegrationContext } from "@openmapx/core";
import * as transitland from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  transitland.setTransitlandApiKey(ctx.config.apiKey as string | undefined);
  ctx.registerProvider("transit", {
    id: "transit-transitland",
    prefix: "tl:",
    coverage: { bbox: [-180, -90, 180, 90] as [number, number, number, number] },
    priority: 8,
    getStopsNearby: (lat: number, lng: number, radiusMeters: number) => {
      const deg = radiusMeters / 111_320;
      return transitland.getStops([lng - deg, lat - deg, lng + deg, lat + deg]);
    },
    getStop: (id: string) => transitland.getStop(id),
    getDepartures: (id: string, min: number) => transitland.getDepartures(id, min),
    getRoute: (id: string) => transitland.getRoute(id),
  });
}
