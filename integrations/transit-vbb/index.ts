import type { IntegrationContext } from "@openmapx/integration-framework";
import * as hafas from "@openmapx/integration-transit-hafas/provider";

export function setup(ctx: IntegrationContext): void {
  const inst = hafas.HAFAS_INSTANCES.find((i) => i.prefix === "vbb:");
  if (!inst) return;

  ctx.registerProvider("transit", {
    id: "transit-vbb",
    prefix: "vbb:",
    coverage: { bbox: [11.26, 51.36, 14.77, 53.56] },
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
