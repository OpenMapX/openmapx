import type { IntegrationContext } from "@openmapx/core";
import * as gtfsLocal from "../../apps/api/src/services/transit/providers/gtfs-local.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerProvider("transit", {
    id: "transit-gtfs-local",
    prefix: "g-",
    coverage: { bbox: [-180, -90, 180, 90] as [number, number, number, number] },
    priority: 3,
    getStopsNearby: (lat: number, lng: number, radiusMeters: number) => {
      const deg = radiusMeters / 111_320;
      const bbox: [number, number, number, number] = [lng - deg, lat - deg, lng + deg, lat + deg];
      return gtfsLocal.hasCoverage(bbox) ? gtfsLocal.getStops(bbox) : Promise.resolve([]);
    },
    getStop: (id: string) => gtfsLocal.getStopById(id),
    getDepartures: (id: string, min: number) => gtfsLocal.getDepartures(id, min),
    getArrivals: (id: string, min: number) => gtfsLocal.getArrivals(id, min),
    searchByName: (q: string, limit: number) => gtfsLocal.searchByName(q, limit),
  });
}
