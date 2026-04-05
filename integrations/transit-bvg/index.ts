import type { IntegrationContext } from "@openmapx/core";
import * as hafas from "../transit-hafas/provider.js";

export function setup(ctx: IntegrationContext): void {
  const inst = hafas.HAFAS_INSTANCES.find((i) => i.prefix === "bvg:");
  if (!inst) return;

  ctx.registerProvider("transit", {
    id: "transit-bvg",
    prefix: "bvg:",
    coverage: { bbox: [13.08, 52.33, 13.77, 52.68] },
    priority: 1,

    getStopsNearby: (lat: number, lng: number, radiusMeters: number) =>
      hafas.getStopsNearby(inst, lat, lng, radiusMeters),

    getStop: (stopId: string) => hafas.getStop(inst, stopId),

    getDepartures: (stopId: string, minutes: number) => hafas.getDepartures(inst, stopId, minutes),

    getArrivals: (stopId: string, minutes: number) => hafas.getArrivals(inst, stopId, minutes),

    searchByName: (query: string, limit: number) => hafas.searchByName(inst, query, limit),

    getStopAlerts: (stopId: string) => hafas.getStopAlerts(inst, stopId),
  });
}
