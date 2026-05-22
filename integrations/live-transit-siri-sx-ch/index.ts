import * as otdCh from "@integrations/transit-opentransportdata-ch/provider.js";
import type { BBox } from "@openmapx/core";
import type { IntegrationContext, RealtimeProvider } from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";

const PROVIDER_ID = "live-transit-siri-sx-ch";
const SWITZERLAND_BBOX: BBox = [5.96, 45.82, 10.49, 47.81];

const ATTRIBUTION: Attribution[] = [
  {
    sourceId: "opentransportdata-ch-siri-sx",
    name: "Open Transport Data CH SIRI-SX",
    url: "https://opentransportdata.swiss/",
    spdxLicense: "CC-BY-4.0",
    licenseUrl: "https://opentransportdata.swiss/en/terms-of-use/",
    attributionText:
      "Service Information / Situation Exchange provided by SBB / opentransportdata.swiss",
    publisher: {
      name: "SBB AG (Open Transport Data Switzerland)",
      url: "https://opentransportdata.swiss/",
    },
  },
];

export function setup(ctx: IntegrationContext): void {
  const provider: RealtimeProvider = {
    id: PROVIDER_ID,
    coverage: { bbox: SWITZERLAND_BBOX },
    priority: 5,
    attribution: ATTRIBUTION,
    capabilities: {
      vehiclePositions: false,
      alerts: { byStop: true, byRoute: true, byBbox: true },
      tripUpdates: false,
    },
    async getAlertsForStop(stopId) {
      const data = await otdCh.getStopAlerts(stopId);
      return withAttribution(data, ATTRIBUTION, freshnessNow({ hasRealtimeData: true }));
    },
    async getAlertsForRoute(routeId) {
      const data = await otdCh.getRouteAlerts(routeId);
      return withAttribution(data, ATTRIBUTION, freshnessNow({ hasRealtimeData: true }));
    },
    async getAlertsForBbox(bbox) {
      const data = await otdCh.getAlerts(bbox);
      return withAttribution(data, ATTRIBUTION, freshnessNow({ hasRealtimeData: true }));
    },
  };

  ctx.registerRealtimeProvider(provider);
}
