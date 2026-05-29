import { setOverpassUrl } from "@openmapx/core";
import { defineTransitProvider, type IntegrationContext } from "@openmapx/integration-framework";
import * as overpass from "./provider.js";

const { attribution, wrap, init } = defineTransitProvider();

export function setup(ctx: IntegrationContext): void {
  init(ctx);
  const resolved = ctx.getRequiredService("overpass");
  if (resolved?.url) setOverpassUrl(resolved.url);

  const overpassFallbackEnabled = process.env.OPENMAPX_OVERPASS_TRANSIT_FALLBACK === "true";
  if (!overpassFallbackEnabled) {
    ctx.log.info(
      "transit-overpass disabled (set OPENMAPX_OVERPASS_TRANSIT_FALLBACK=true to enable)",
    );
    return;
  }

  ctx.registerTransitProvider({
    id: "transit-overpass",
    prefix: "osm:",
    coverage: { all: true },
    priority: 10,
    attribution: attribution.all(),
    capabilities: {
      stops: {
        lookup: false,
        nearby: true,
        bbox: false,
        search: false,
        infrastructure: false,
        platforms: false,
        timetable: false,
      },
      departures: false,
      arrivals: false,
      routes: { lookup: false, forStop: false, stops: false, geometry: false },
      planning: false,
      vehiclePositions: false,
      vehicleJourney: false,
      alerts: { byStop: false, byRoute: false, byBbox: false },
      facilities: false,
    },
    async getStopsNearby(lat, lng, radiusMeters) {
      const deg = radiusMeters / 111_320;
      return wrap(await overpass.getStops([lng - deg, lat - deg, lng + deg, lat + deg]));
    },
  });
}
