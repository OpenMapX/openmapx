import * as otdCh from "@integrations/transit-opentransportdata-ch/provider.js";
import type { BBox } from "@openmapx/core";
import {
  createManifestAttribution,
  type IntegrationContext,
  type RealtimeProvider,
} from "@openmapx/integration-framework";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";

const PROVIDER_ID = "live-transit-siri-sx-ch";
const SWITZERLAND_BBOX: BBox = [5.96, 45.82, 10.49, 47.81];

const attribution = createManifestAttribution();

export function setup(ctx: IntegrationContext): void {
  ctx.onActivate(() => attribution.set(ctx.manifest.dataSources ?? []));
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
    async getAlertsForStop(stopId) {
      const data = await otdCh.getStopAlerts(stopId);
      return withAttribution(data, attribution.all(), freshnessNow({ hasRealtimeData: true }));
    },
    async getAlertsForRoute(routeId) {
      const data = await otdCh.getRouteAlerts(routeId);
      return withAttribution(data, attribution.all(), freshnessNow({ hasRealtimeData: true }));
    },
    async getAlertsForBbox(bbox) {
      const data = await otdCh.getAlerts(bbox);
      return withAttribution(data, attribution.all(), freshnessNow({ hasRealtimeData: true }));
    },
  };

  ctx.registerRealtimeProvider(provider);
}
