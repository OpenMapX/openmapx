import { mobilityHttpTransport } from "@openmapx/core/mobility-http-transport";
import { createDataSourceResolver } from "@openmapx/integration-data-source/resolver";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { createSharedMobilityContributorResolver } from "@openmapx/integration-framework/shared-mobility-provider";
import { createSharedMobilityRuntime } from "@openmapx/mobility-core/shared-mobility-runtime";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { beCoopstroomClient, beDegageClient } from "./providers/be-degapp.js";
import { caCommunautoClient } from "./providers/ca-communauto-client.js";
import { deCambioClient } from "./providers/de-cambio-client.js";
import { deNwBielefeldClient } from "./providers/de-nw-bielefeld-client.js";
import { deNwWuppertalClient } from "./providers/de-nw-wuppertal-client.js";
import { deStadtteilautoClient } from "./providers/de-stadtteilauto-client.js";
import { createCarSharingProvider } from "./providers/provider.js";
import { createRegionalCarSharingRegistry } from "./providers/registry.js";

export function setup(ctx: IntegrationContext): void {
  const motis = ctx.getRequiredService("motis");
  const nominatim = ctx.getRequiredService("nominatim");
  const resolveContributors = createSharedMobilityContributorResolver(
    ctx.manifest.dataSources ?? [],
  );
  const runtime = createSharedMobilityRuntime({
    resolveContributors,
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
  ctx.onShutdown(async () => runtime.dispose());
  const searchRegionalClients = createRegionalCarSharingRegistry({
    cache: runtime.cache,
    resolveContributors,
    log: ctx.log,
    clients: [
      deCambioClient,
      deStadtteilautoClient,
      deNwWuppertalClient,
      deNwBielefeldClient,
      caCommunautoClient,
      beCoopstroomClient,
      beDegageClient,
    ],
  });
  const carSharingProvider = createCarSharingProvider({
    runtime,
    dataSources: ctx.manifest.dataSources ?? [],
    searchRegionalClients,
  });
  ctx.registerMobilityDataSource(carSharingProvider);
  registerPlaceResolver(carSharingProvider.id, createDataSourceResolver(carSharingProvider));
}
