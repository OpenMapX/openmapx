import { setOverpassUrl } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";
import * as overpass from "./provider.js";

const ATTRIBUTION: Attribution[] = [
  {
    sourceId: "overpass",
    name: "OpenStreetMap (Overpass)",
    url: "https://overpass-api.de/",
    spdxLicense: "ODbL-1.0",
    licenseUrl: "https://www.openstreetmap.org/copyright",
    attributionText: "© OpenStreetMap contributors",
  },
];

const wrap = <T>(data: T) => withAttribution(data, ATTRIBUTION, freshnessNow());

export function setup(ctx: IntegrationContext): void {
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
    attribution: ATTRIBUTION,
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
