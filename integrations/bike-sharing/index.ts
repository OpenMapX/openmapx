import { mobilityHttpTransport } from "@openmapx/core/mobility-http-transport";
import { createDataSourceResolver } from "@openmapx/integration-data-source/resolver";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { createSharedMobilityRuntime } from "@openmapx/mobility-core/shared-mobility-runtime";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { searchCityBikes } from "./providers/citybikes-client.js";
import { createDbBikeClient } from "./providers/db-bike-client.js";
import { searchDonkey } from "./providers/donkey-client.js";
import { searchNextbike } from "./providers/nextbike-client.js";
import { createBikeSharingProvider } from "./providers/provider.js";

export function setup(ctx: IntegrationContext): void {
  const motis = ctx.getRequiredService("motis");
  const nominatim = ctx.getRequiredService("nominatim");
  const runtime = createSharedMobilityRuntime({
    cache: ctx.cache,
    transport: mobilityHttpTransport,
    motisUrl: motis?.url,
    nominatimUrl: nominatim?.url,
    onDecision(category, decision) {
      ctx.metricsRecorder?.recordProviderCall(
        {
          providerId: `shared-mobility-${category}`,
          method: "source-policy",
          outcome: decision.partial ? "error" : decision.calledAdapters.length ? "ok" : "skipped",
        },
        0,
      );
    },
  });
  const bikeSharingProvider = createBikeSharingProvider({
    runtime,
    dataSources: ctx.manifest.dataSources ?? [],
    searchCityBikes,
    searchDbBikes: createDbBikeClient({
      clientId: ctx.config["db-bike-client-id"] as string | undefined,
      apiKey: ctx.config["db-bike-api-key"] as string | undefined,
      transport: runtime.transport,
    }),
    searchDonkey,
    searchNextbike,
  });
  ctx.registerMobilityDataSource(bikeSharingProvider);
  registerPlaceResolver(bikeSharingProvider.id, createDataSourceResolver(bikeSharingProvider));
}
