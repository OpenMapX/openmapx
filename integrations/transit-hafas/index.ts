import type { IntegrationContext } from "@openmapx/core";
import * as hafas from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  // Register DB HAFAS as a transit provider (VBB and BVG are registered by their own integrations)
  const dbInst = hafas.HAFAS_INSTANCES.find((i) => i.id === "db");
  if (dbInst) {
    ctx.registerProvider("transit", {
      id: "transit-hafas-db",
      prefix: "db-hafas:",
      coverage: { bbox: [5.87, 47.27, 15.04, 55.06] as [number, number, number, number] },
      priority: 3,
      getStopsNearby: (lat: number, lng: number, radiusMeters: number) =>
        hafas.getStopsNearby(dbInst, lat, lng, radiusMeters),
      getStop: (stopId: string) => hafas.getStop(dbInst, stopId),
      getDepartures: (stopId: string, minutes: number) =>
        hafas.getDepartures(dbInst, stopId, minutes),
      getArrivals: (stopId: string, minutes: number) => hafas.getArrivals(dbInst, stopId, minutes),
      searchByName: (query: string, limit: number) => hafas.searchByName(dbInst, query, limit),
    });
  }
}
