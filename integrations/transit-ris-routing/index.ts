import { defineTransitProvider, type IntegrationContext } from "@openmapx/integration-framework";
import * as ris from "./provider.js";

const { attribution, wrapRT, init } = defineTransitProvider();

export function setup(ctx: IntegrationContext): void {
  init(ctx);
  const clientId = ctx.config.clientId as string | undefined;
  const apiKey = ctx.config.apiKey as string | undefined;
  ctx.onActivate(() => {
    ris.setRisCredentials({ clientId, apiKey });
  });
  if (!clientId?.trim() || !apiKey?.trim()) return;

  ctx.registerTransitProvider({
    id: "transit-ris-routing",
    prefix: "ris:",
    coverage: { bbox: [5.87, 47.27, 15.04, 55.06] },
    priority: 1,
    role: "regional",
    attribution: attribution.all(),
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
      if (!ris.risCanHonor(params)) return wrapRT([]);
      const arriveBy = params.arrivalTime != null;
      const when = arriveBy ? params.arrivalTime : params.departureTime;
      const dt = when ? new Date(when) : new Date();
      const date = dt.toISOString().slice(0, 10);
      const time = dt.toISOString().slice(11, 16);

      const plan = await ris.planJourney(
        params.from.lat,
        params.from.lng,
        params.to.lat,
        params.to.lng,
        date,
        time,
        arriveBy,
        params.numItineraries,
      );
      return wrapRT(plan ? [plan] : []);
    },
  });
}
