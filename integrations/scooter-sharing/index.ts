import { createDataSourceResolver } from "@openmapx/integration-data-source/resolver";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { initCache } from "@openmapx/mobility-core/cache";
import { setSharedMobilityMotisUrl } from "@openmapx/mobility-core/motis-rentals";
import { setSharedMobilityNominatimUrl } from "@openmapx/mobility-core/nominatim";
import { setSharedMobilityDecisionObserver } from "@openmapx/mobility-core/shared-mobility-orchestrator";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { setDeNwMobidromScooterCredentials } from "./providers/de-nw-mobidrom-scooter-client.js";
import {
  scooterSharingProvider,
  setDetailCache,
  setManifestDataSources,
} from "./providers/provider.js";

export function setup(ctx: IntegrationContext): void {
  const motis = ctx.getRequiredService("motis");
  const nominatim = ctx.getRequiredService("nominatim");
  ctx.onActivate(() => {
    initCache(ctx.cache);
    setDetailCache(ctx.cache);
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
    if (motis?.url) setSharedMobilityMotisUrl(motis.url);
    if (nominatim?.url) setSharedMobilityNominatimUrl(nominatim.url);
    setDeNwMobidromScooterCredentials({
      clientId: ctx.config["de-nw-mobidrom-scooter-client-id"] as string | undefined,
      clientSecret: ctx.config["de-nw-mobidrom-scooter-client-secret"] as string | undefined,
    });
  });
  ctx.registerMobilityDataSource(scooterSharingProvider);
  registerPlaceResolver(
    scooterSharingProvider.id,
    createDataSourceResolver(scooterSharingProvider),
  );
}
