import type { BBox } from "@openmapx/core";
import {
  createManifestAttribution,
  type IntegrationContext,
  type RealtimeProvider,
  type TransitProvider,
} from "@openmapx/integration-framework";

const PROVIDER_ID = "live-transit-siri-sx-ch";
const SWITZERLAND_BBOX: BBox = [5.96, 45.82, 10.49, 47.81];

export function setup(ctx: IntegrationContext): void {
  const attribution = createManifestAttribution();
  attribution.set(ctx.manifest.dataSources ?? []);
  // The host supplies the staged dependency graph during detached setup.
  // Capture that generation once: later reloads must not retarget this provider.
  const dependency = ctx
    .getIntegrationsByDomain("transit")
    .find((integration) => integration.id === "transit-opentransportdata-ch");
  const swiss = (dependency?.providers.get("transit") as TransitProvider[] | undefined)?.find(
    (provider) => provider.id === "transit-opentransportdata-ch",
  );
  if (!swiss?.getAlertsForStop || !swiss.getAlertsForRoute || !swiss.getAlertsForBbox) {
    throw new Error("Swiss SIRI requires its staged Swiss transit alert provider");
  }
  const { getAlertsForStop, getAlertsForRoute, getAlertsForBbox } = swiss;
  const provider: RealtimeProvider = {
    id: PROVIDER_ID,
    coverage: { bbox: SWITZERLAND_BBOX },
    priority: 5,
    attribution: attribution.all(),
    capabilities: {
      vehiclePositions: false,
      alerts: { byStop: true, byRoute: true, byBbox: true },
      tripUpdates: false,
    },
    getAlertsForStop: (stopId) => getAlertsForStop.call(swiss, stopId),
    getAlertsForRoute: (routeId) => getAlertsForRoute.call(swiss, routeId),
    getAlertsForBbox: (bbox) => getAlertsForBbox.call(swiss, bbox),
  };
  ctx.registerRealtimeProvider(provider);
}
