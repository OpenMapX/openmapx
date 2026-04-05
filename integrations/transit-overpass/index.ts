import type { IntegrationContext } from "@openmapx/core";
import * as overpass from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerProvider("transit", {
    id: "transit-overpass",
    prefix: "osm:",
    coverage: { bbox: [-180, -90, 180, 90] as [number, number, number, number] },
    priority: 10,
    getStopsNearby: (lat: number, lng: number, radiusMeters: number) => {
      const deg = radiusMeters / 111_320;
      return overpass.getStops([lng - deg, lat - deg, lng + deg, lat + deg]);
    },
  });
}
