import { setOverpassUrl } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import * as overpass from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  const resolved = ctx.getRequiredService("overpass");
  if (resolved?.url) setOverpassUrl(resolved.url);
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
