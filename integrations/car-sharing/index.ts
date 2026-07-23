import { createDataSourceResolver } from "@openmapx/integration-data-source/resolver";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { initCache } from "@openmapx/mobility-core/cache";
import { setSharedMobilityMotisUrl } from "@openmapx/mobility-core/motis-rentals";
import { setSharedMobilityNominatimUrl } from "@openmapx/mobility-core/nominatim";
import { setSharedMobilityDecisionObserver } from "@openmapx/mobility-core/shared-mobility-orchestrator";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { beCoopstroomClient, beDegageClient } from "./providers/be-degapp.js";
import { caCommunautoClient } from "./providers/ca-communauto-client.js";
import { deCambioClient } from "./providers/de-cambio-client.js";
import { deNwBielefeldClient } from "./providers/de-nw-bielefeld-client.js";
import { deNwWuppertalClient } from "./providers/de-nw-wuppertal-client.js";
import { deStadtteilautoClient } from "./providers/de-stadtteilauto-client.js";
import {
  carSharingProvider,
  setDetailCache,
  setManifestDataSources,
} from "./providers/provider.js";
import { registerCarSharingClient, setCarSharingLogger } from "./providers/registry.js";

export function setup(ctx: IntegrationContext): void {
  initCache(ctx.cache);
  setDetailCache(ctx.cache);
  const motis = ctx.getRequiredService("motis");
  const nominatim = ctx.getRequiredService("nominatim");
  if (motis?.url) setSharedMobilityMotisUrl(motis.url);
  if (nominatim?.url) setSharedMobilityNominatimUrl(nominatim.url);

  setCarSharingLogger(ctx.log);
  registerCarSharingClient(deCambioClient);
  registerCarSharingClient(deStadtteilautoClient);
  registerCarSharingClient(deNwWuppertalClient);
  registerCarSharingClient(deNwBielefeldClient);
  registerCarSharingClient(caCommunautoClient);
  registerCarSharingClient(beCoopstroomClient);
  registerCarSharingClient(beDegageClient);

  setManifestDataSources(ctx.manifest.dataSources ?? []);
  setSharedMobilityDecisionObserver((category, decision) => {
    ctx.metricsRecorder?.recordProviderCall(
      {
        providerId: `shared-mobility-${category}`,
        method: "source-policy",
        outcome: decision.partial ? "error" : decision.calledAdapters.length ? "ok" : "skipped",
      },
      0,
    );
  });
  ctx.registerMobilityDataSource(carSharingProvider);
  registerPlaceResolver(carSharingProvider.id, createDataSourceResolver(carSharingProvider));
}
