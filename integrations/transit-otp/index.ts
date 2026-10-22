import {
  captureTransitContributors,
  type IntegrationContext,
  resolveIntegrationContributors,
  snapshotContributors,
} from "@openmapx/integration-framework";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";
import { transitDataContributors } from "@openmapx/mobility-core/transit-contributors";
import { createOtpClient, OtpError } from "@openmapx/otp-client";
import { createOtpProvider } from "./provider";

export function setup(ctx: IntegrationContext): void {
  const generation = new AbortController();
  const receipts = snapshotContributors(resolveIntegrationContributors(ctx, ["otp"]));
  const client = createOtpClient({
    endpoint:
      ctx.getRequiredService("otp")?.url ??
      (typeof ctx.config.endpoint === "string" ? ctx.config.endpoint : "http://localhost:8090"),
    http: ctx.http,
    signal: generation.signal,
    isSourceAllowed: async () => {
      const denied = await ctx.getDisallowedSourceIds?.();
      return !denied?.has("otp") && !denied?.has(ctx.id);
    },
  });
  const provider = createOtpProvider(client);
  ctx.onShutdown(async () => {
    generation.abort();
  });
  ctx.registerHealthCheck(async () => {
    try {
      await client.sdk.OtpReadiness();
      if (generation.signal.aborted) throw new OtpError("cancelled");
      return { status: "up" };
    } catch (error) {
      return {
        status: "down",
        error: error instanceof OtpError ? error.message : "OTP upstream unavailable",
      };
    }
  });
  ctx.registerTransitProvider({
    id: "transit-otp",
    prefix: "otp:",
    coverage: { all: true },
    priority: 6,
    role: "regional",
    attribution: receipts,
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
      await client.assertAvailable();
      // OTP's RAIL includes long-distance trains, so defer the D-ticket request.
      const data = params.deutschlandticketOnly ? [] : [await provider.plan(params)];
      await client.assertAvailable();
      if (generation.signal.aborted) throw new OtpError("cancelled");
      const credited = captureTransitContributors(data, receipts);
      return withAttribution(
        credited,
        transitDataContributors(credited),
        freshnessNow({
          hasRealtimeData: credited.some((plan) =>
            plan.itineraries.some((itinerary) =>
              itinerary.legs.some((leg) => leg.realtime === true),
            ),
          ),
        }),
      );
    },
  });
}
