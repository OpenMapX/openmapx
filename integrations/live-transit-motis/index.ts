import { type Client, createClient } from "@hey-api/client-fetch";
import {
  type AlertSeverityLevel,
  type Alert as MotisAlert,
  trip as motisTrip,
  stoptimes,
} from "@motis-project/motis-client";
import { USER_AGENT_TRANSIT } from "@openmapx/core";
import type { IntegrationContext, RealtimeProvider } from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";
import type { AlertSeverity, ServiceAlert } from "@openmapx/mobility-core/transit";

const DEFAULT_MOTIS_URL = "http://localhost:8081";
const TIMEOUT_MS = 8_000;
const PROVIDER_ID = "live-transit-motis";
const SOURCE_ID = "motis-rt";
const ALERT_PREFIX = "mr:";

const ATTRIBUTION: Attribution[] = [
  {
    sourceId: SOURCE_ID,
    name: "MOTIS GTFS-RT Pass-through",
    url: "https://motis-project.de/",
    notes: "Alerts and trip updates surfaced from the locally-hosted MOTIS instance.",
  },
];

const client: Client = (() => {
  const c = createClient({
    baseUrl: DEFAULT_MOTIS_URL,
    headers: { "User-Agent": USER_AGENT_TRANSIT },
  });
  c.interceptors.request.use((request) => {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    return new Request(request, { signal });
  });
  return c;
})();

function stripPrefix(id: string): string {
  return id.replace(/^(ms:|mo:|mr:)/, "");
}

function mapMotisAlertSeverity(level?: AlertSeverityLevel): AlertSeverity {
  switch (level) {
    case "SEVERE":
      return "severe";
    case "WARNING":
      return "warning";
    case "INFO":
      return "info";
    default:
      return "info";
  }
}

function mapMotisAlert(alert: MotisAlert, index: number): ServiceAlert {
  const idSeed = alert.code ?? `${alert.headerText}-${index}`;
  const periods = (alert.impactPeriod ?? []).flatMap((range) => {
    if (!range.start) return [];
    return [
      {
        start: range.start,
        end: range.end ?? undefined,
      },
    ];
  });

  return {
    id: `${ALERT_PREFIX}${idSeed}`,
    providers: [SOURCE_ID],
    severity: mapMotisAlertSeverity(alert.severityLevel),
    effect: alert.effect ?? alert.effectDetail ?? undefined,
    title: alert.headerText,
    description: alert.descriptionText || undefined,
    affectedRouteIds: [],
    affectedStopIds: [],
    activePeriods: periods,
  };
}

export function setup(ctx: IntegrationContext): void {
  const resolved = ctx.getRequiredService?.("motis");
  const motisUrl =
    resolved?.url ?? (ctx.config.endpoint as string | undefined) ?? DEFAULT_MOTIS_URL;
  client.setConfig({ baseUrl: motisUrl, headers: { "User-Agent": USER_AGENT_TRANSIT } });

  const provider: RealtimeProvider = {
    id: PROVIDER_ID,
    coverage: { all: true },
    priority: 12,
    attribution: ATTRIBUTION,
    capabilities: {
      vehiclePositions: false,
      alerts: { byStop: true, byRoute: false, byBbox: false },
      tripUpdates: true,
    },
    async getAlertsForStop(stopId) {
      try {
        const { data } = await stoptimes({
          client,
          query: { stopId: stripPrefix(stopId), n: 0, window: 0, withAlerts: true },
        });
        const motisAlerts: MotisAlert[] = data?.place?.alerts ?? [];
        const mapped = motisAlerts.map((alert, index) => mapMotisAlert(alert, index));
        return withAttribution(mapped, ATTRIBUTION, freshnessNow({ hasRealtimeData: true }));
      } catch {
        return withAttribution([], ATTRIBUTION, freshnessNow({ hasRealtimeData: true }));
      }
    },
    async getTripUpdate(tripId) {
      try {
        const { data } = await motisTrip({
          client,
          query: { tripId: stripPrefix(tripId) },
        });
        return withAttribution(data ?? null, ATTRIBUTION, freshnessNow({ hasRealtimeData: true }));
      } catch {
        return withAttribution(null, ATTRIBUTION, freshnessNow({ hasRealtimeData: true }));
      }
    },
  };

  ctx.registerRealtimeProvider(provider);
}

export const __testing = {
  mapMotisAlert,
  mapMotisAlertSeverity,
  stripPrefix,
};
