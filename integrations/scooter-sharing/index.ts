import { mobilityHttpTransport } from "@openmapx/core/mobility-http-transport";
import { createDataSourceResolver } from "@openmapx/integration-data-source/resolver";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { createSharedMobilityRuntime } from "@openmapx/mobility-core/shared-mobility-runtime";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { createDeNwMobidromScooterClient } from "./providers/de-nw-mobidrom-scooter-client.js";
import { searchFelyx } from "./providers/felyx-client.js";
import { createScooterSharingProvider } from "./providers/provider.js";

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
  const scooterSharingProvider = createScooterSharingProvider({
    runtime,
    dataSources: ctx.manifest.dataSources ?? [],
    searchDeNwMobidromScooter: createDeNwMobidromScooterClient({
      clientId: ctx.config["de-nw-mobidrom-scooter-client-id"] as string | undefined,
      clientSecret: ctx.config["de-nw-mobidrom-scooter-client-secret"] as string | undefined,
      transport: runtime.transport,
    }),
    searchFelyx,
  });
  ctx.registerMobilityDataSource(scooterSharingProvider);
  registerPlaceResolver(
    scooterSharingProvider.id,
    createDataSourceResolver(scooterSharingProvider),
  );
}
