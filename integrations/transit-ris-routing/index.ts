import type { IntegrationContext } from "@openmapx/integration-framework";
import * as ris from "./provider.js";
import { setRisCredentials } from "./ris-client.js";

export function setup(ctx: IntegrationContext): void {
  setRisCredentials({
    clientId: ctx.config.clientId as string | undefined,
    apiKey: ctx.config.apiKey as string | undefined,
  });
  if (!ris.isConfigured()) return;

  ctx.registerProvider("transit", {
    id: "transit-ris-routing",
    prefix: "ris:",
    coverage: { bbox: [5.87, 47.27, 15.04, 55.06] },
    priority: 1,

    planTrip: async (params: {
      from: { lat: number; lng: number };
      to: { lat: number; lng: number };
      departureTime?: string;
    }) => {
      const departureTime = params.departureTime ? new Date(params.departureTime) : new Date();
      const date = departureTime.toISOString().slice(0, 10);
      const time = departureTime.toISOString().slice(11, 16);

      return ris.planJourney(
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
