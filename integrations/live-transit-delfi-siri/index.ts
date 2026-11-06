import {
  createManifestAttribution,
  type IntegrationContext,
  type RealtimeProvider,
} from "@openmapx/integration-framework";
import { withAttribution } from "@openmapx/mobility-core/result";
import { createSiriClient } from "./client";
import { matchJourneyPlatforms } from "./match";

export function setup(ctx: IntegrationContext): void {
  const attribution = createManifestAttribution();
  attribution.set(ctx.manifest.dataSources ?? []);
  const client = createSiriClient(ctx);
  const provider: RealtimeProvider = {
    id: "live-transit-delfi-siri",
    coverage: { bbox: [5.8, 49.5, 9.5, 53] },
    priority: 5,
    attribution: attribution.all(),
    capabilities: {
      vehiclePositions: false,
      alerts: { byStop: false, byRoute: false, byBbox: false },
      tripUpdates: false,
      journeyPlatforms: true,
    },
    async getJourneyPlatforms(journey) {
      const identity = journey.identity;
      const snapshot = identity
        ? await client.get(identity.serviceDate, identity.trainNumber)
        : undefined;
      const data = snapshot
        ? matchJourneyPlatforms(journey, snapshot.records, Date.now(), snapshot.fetchedAt)
        : [];
      const evidence = data
        .flatMap((s) => [s.arrivalPlatform, s.departurePlatform])
        .filter((e) => !!e);
      return withAttribution(data, evidence.length ? attribution.all() : [], {
        fetchedAt: snapshot?.fetchedAt ?? new Date().toISOString(),
        hasRealtimeData: evidence.some((e) => e.kind === "realtime"),
        isStale: false,
        ...(evidence.length
          ? { dataAsOf: evidence.flatMap((e) => (e.recordedAt ? [e.recordedAt] : [])).sort()[0] }
          : {}),
      });
    },
  };
  ctx.registerRealtimeProvider(provider);
}
