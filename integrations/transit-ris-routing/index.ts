import type { IntegrationContext } from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";
import * as ris from "./provider.js";
import { setRisCredentials } from "./ris-client.js";

const ATTRIBUTION: Attribution[] = [
  {
    sourceId: "db-ris-routing",
    name: "Deutsche Bahn RIS Routing",
    url: "https://apis.deutschebahn.com/",
    licenseUrl: "https://developers.deutschebahn.com/db-api-marketplace/apis/nutzungsbedingungen",
  },
];

const wrapRT = <T>(data: T) =>
  withAttribution(data, ATTRIBUTION, freshnessNow({ hasRealtimeData: true }));

export function setup(ctx: IntegrationContext): void {
  setRisCredentials({
    clientId: ctx.config.clientId as string | undefined,
    apiKey: ctx.config.apiKey as string | undefined,
  });
  if (!ris.isConfigured()) return;

  ctx.registerTransitProvider({
    id: "transit-ris-routing",
    prefix: "ris:",
    coverage: { bbox: [5.87, 47.27, 15.04, 55.06] },
    priority: 1,
    attribution: ATTRIBUTION,
    capabilities: {
      stops: {
        lookup: false,
        nearby: false,
        bbox: false,
        search: false,
        infrastructure: false,
        platforms: false,
        timetable: false,
      },
      departures: false,
      arrivals: false,
      routes: { lookup: false, forStop: false, stops: false, geometry: false },
      planning: true,
      vehiclePositions: false,
      vehicleJourney: false,
      alerts: { byStop: false, byRoute: false, byBbox: false },
      facilities: false,
    },

    async planTrip(params) {
      const departureTime = params.departureTime ? new Date(params.departureTime) : new Date();
      const date = departureTime.toISOString().slice(0, 10);
      const time = departureTime.toISOString().slice(11, 16);

      const plan = await ris.planJourney(
        params.from.lat,
        params.from.lng,
        params.to.lat,
        params.to.lng,
        date,
        time,
      );
      return wrapRT(plan ? [plan] : []);
    },
  });
}
