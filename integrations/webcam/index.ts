import { setOverpassUrl } from "@openmapx/core";
import { createDataSourceResolver } from "@openmapx/integration-data-source/resolver";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { initCache } from "./cache.js";
import { setCameraSourceCredentials } from "./providers/camera-sources.js";
import { setManifestDataSources, webcamProvider } from "./providers/provider.js";
import { setNpsApiKey } from "./providers/us-nps.js";
import { setUsStateSourceLogger } from "./providers/us-state-sources.js";
import { setWindyApiKey } from "./providers/windy.js";

export function setup(ctx: IntegrationContext): void {
  initCache(ctx.cache);
  const resolved = ctx.getRequiredService("overpass");
  if (resolved?.url) setOverpassUrl(resolved.url);
  setUsStateSourceLogger(ctx.log);
  setWindyApiKey(ctx.config["windy-api-key"] as string | undefined);
  setNpsApiKey(ctx.config["us-nps-api-key"] as string | undefined);
  setCameraSourceCredentials({
    "se-trafikverket-api-key": ctx.config["se-trafikverket-api-key"] as string | undefined,
    "no-npra-username": ctx.config["no-npra-username"] as string | undefined,
    "no-npra-password": ctx.config["no-npra-password"] as string | undefined,
    "au-nsw-webcam-api-key": ctx.config["au-nsw-webcam-api-key"] as string | undefined,
    "tw-tdx-webcam-client-id": ctx.config["tw-tdx-webcam-client-id"] as string | undefined,
    "tw-tdx-webcam-client-secret": ctx.config["tw-tdx-webcam-client-secret"] as string | undefined,
  });
  setManifestDataSources(ctx.manifest.dataSources ?? []);
  ctx.registerMobilityDataSource(webcamProvider);
  registerPlaceResolver(webcamProvider.id, createDataSourceResolver(webcamProvider));
}
