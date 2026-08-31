import { setOverpassUrl } from "@openmapx/core";
import { createDataSourceResolver } from "@openmapx/integration-data-source/resolver";
import {
  createStagedRuntimeValue,
  type IntegrationContext,
  stageRuntimeGeneration,
} from "@openmapx/integration-framework";
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
import { evRuntime } from "./runtime.js";

interface EvRuntimeConfiguration {
  context: IntegrationContext;
  overpassUrl?: string;
}

function applyRuntimeConfiguration(configuration: EvRuntimeConfiguration): void {
  const { context } = configuration;
  initCache(context.cache);
  if (configuration.overpassUrl) setOverpassUrl(configuration.overpassUrl);
  setOcmApiKey(context.config["ocm-api-key"] as string | undefined);
  setUsAfdcApiKey(context.config["us-afdc-api-key"] as string | undefined);
  setNoNobilApiKey(context.config["no-nobil-api-key"] as string | undefined);
  setSiNapToken(context.config["si-nap-api-key"] as string | undefined);
  setAtEcontrolApiKey(context.config["at-econtrol-api-key"] as string | undefined);
  setAtEcontrolRefererDomain(context.config["at-econtrol-referer-domain"] as string | undefined);
  setSgLtaDatamallApiKey(context.config["sg-ltadatamall-api-key"] as string | undefined);
  setTwTdxCredentials(
    context.config["tw-tdx-client-id"] as string | undefined,
    context.config["tw-tdx-client-secret"] as string | undefined,
  );
  setLogger(context.log);
  setManifestDataSources(context.manifest.dataSources ?? []);
}

const runtimeConfiguration = createStagedRuntimeValue(applyRuntimeConfiguration);

export function setup(ctx: IntegrationContext): void {
  stageRuntimeGeneration(ctx, evRuntime, ctx, () => {
    runtimeConfiguration.stage(evRuntime, {
      context: ctx,
      overpassUrl: ctx.getRequiredService("overpass")?.url,
    });
    ctx.registerPoiSources(declarePoiSources());
    ctx.registerMobilityDataSource(evChargingProvider);
    registerPlaceResolver(evChargingProvider.id, createDataSourceResolver(evChargingProvider));
  });
}
