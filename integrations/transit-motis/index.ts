import type { IntegrationContext } from "@openmapx/core";
import * as motis from "../../apps/api/src/services/motis/adapter.js";
import {
  motisLocalInstance,
  transitousInstance,
} from "../../apps/api/src/services/motis/instances.js";
import { motisManager } from "../../apps/api/src/services/motis/manager.js";

export async function setup(ctx: IntegrationContext): Promise<void> {
  // Register Transitous (cloud MOTIS) as a transit provider
  ctx.registerProvider("transit", {
    id: "transit-motis-transitous",
    prefix: "mo:",
    coverage: { bbox: [-180, -90, 180, 90] as [number, number, number, number] },
    priority: 4,
    getStopsNearby: (lat: number, lng: number, radiusMeters: number) => {
      const deg = radiusMeters / 111_320;
      return motis.getStops(transitousInstance, [lng - deg, lat - deg, lng + deg, lat + deg]);
    },
    getStop: (id: string) => motis.getStopById(transitousInstance, id),
    getDepartures: (id: string, min: number) => motis.getDepartures(transitousInstance, id, min),
    getArrivals: (id: string, min: number) => motis.getArrivals(transitousInstance, id, min),
    searchByName: (q: string, limit: number) => motis.searchByName(transitousInstance, q, limit),
    async planTrip(params: {
      from: { lat: number; lng: number };
      to: { lat: number; lng: number };
      departureTime?: string;
    }) {
      const now = new Date();
      const date = params.departureTime?.slice(0, 10) ?? now.toISOString().slice(0, 10);
      const time = params.departureTime?.slice(11, 19) ?? now.toISOString().slice(11, 19);
      return motis.planTrip(
        transitousInstance,
        params.from.lat,
        params.from.lng,
        params.to.lat,
        params.to.lng,
        date,
        time,
      );
    },
  });

  // Register local MOTIS if available
  if (await motisManager.isReachable()) {
    ctx.registerProvider("transit", {
      id: "transit-motis-local",
      prefix: "ms:",
      coverage: { bbox: [-180, -90, 180, 90] as [number, number, number, number] },
      priority: 3,
      getStopsNearby: (lat: number, lng: number, radiusMeters: number) => {
        const deg = radiusMeters / 111_320;
        return motis.getStops(motisLocalInstance, [lng - deg, lat - deg, lng + deg, lat + deg]);
      },
      getStop: (id: string) => motis.getStopById(motisLocalInstance, id),
      getDepartures: (id: string, min: number) => motis.getDepartures(motisLocalInstance, id, min),
      getArrivals: (id: string, min: number) => motis.getArrivals(motisLocalInstance, id, min),
      searchByName: (q: string, limit: number) => motis.searchByName(motisLocalInstance, q, limit),
      async planTrip(params: {
        from: { lat: number; lng: number };
        to: { lat: number; lng: number };
        departureTime?: string;
      }) {
        const now = new Date();
        const date = params.departureTime?.slice(0, 10) ?? now.toISOString().slice(0, 10);
        const time = params.departureTime?.slice(11, 19) ?? now.toISOString().slice(11, 19);
        return motis.planTrip(
          motisLocalInstance,
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
}
