import { setOverpassUrl } from "@openmapx/core";
import { createDataSourceResolver } from "@openmapx/integration-data-source/resolver";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { initCache } from "./cache.js";
import { declarePoiSources } from "./poi-sources.js";
import { setAtEcontrolApiKey, setAtEcontrolRefererDomain } from "./providers/at-econtrol.js";
import { setNoNobilApiKey } from "./providers/no-nobil.js";
import { setOcmApiKey } from "./providers/ocm.js";
import { evChargingProvider, setLogger, setManifestDataSources } from "./providers/provider.js";
import { setSgLtaDatamallApiKey } from "./providers/sg-ltadatamall.js";
import { setSiNapToken } from "./providers/si-nap.js";
import { setTwTdxCredentials } from "./providers/tw-tdx.js";
import { setUsAfdcApiKey } from "./providers/us-afdc.js";
import { initRuntime, stageRuntimeCommit } from "./runtime.js";

export function setup(ctx: IntegrationContext): void {
  initRuntime(ctx);
  const resolved = ctx.getRequiredService("overpass");
  stageRuntimeCommit(() => {
    initCache(ctx.cache);
    if (resolved?.url) setOverpassUrl(resolved.url);
    setOcmApiKey(ctx.config["ocm-api-key"] as string | undefined);
    setUsAfdcApiKey(ctx.config["us-afdc-api-key"] as string | undefined);
    setNoNobilApiKey(ctx.config["no-nobil-api-key"] as string | undefined);
    setSiNapToken(ctx.config["si-nap-api-key"] as string | undefined);
    setAtEcontrolApiKey(ctx.config["at-econtrol-api-key"] as string | undefined);
    setAtEcontrolRefererDomain(ctx.config["at-econtrol-referer-domain"] as string | undefined);
    setSgLtaDatamallApiKey(ctx.config["sg-ltadatamall-api-key"] as string | undefined);
    setTwTdxCredentials(
      ctx.config["tw-tdx-client-id"] as string | undefined,
      ctx.config["tw-tdx-client-secret"] as string | undefined,
    );
    setLogger(ctx.log);
    setManifestDataSources(ctx.manifest.dataSources ?? []);
  });
  ctx.registerPoiSources(declarePoiSources());
  ctx.registerMobilityDataSource(evChargingProvider);
  registerPlaceResolver(evChargingProvider.id, createDataSourceResolver(evChargingProvider));
}
