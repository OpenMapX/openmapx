import { setOverpassUrl } from "@openmapx/core";
import { createDataSourceResolver } from "@openmapx/integration-data-source/resolver";
import {
  createStagedRuntimeValue,
  type IntegrationContext,
  stageRuntimeGeneration,
} from "@openmapx/integration-framework";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { declarePoiSources } from "./poi-sources.js";
import { parkingProvider, setLogger, setManifestDataSources } from "./providers/provider.js";
import { parkingRuntime } from "./runtime.js";

interface ParkingRuntimeConfiguration {
  context: IntegrationContext;
  overpassUrl?: string;
}

function applyRuntimeConfiguration(configuration: ParkingRuntimeConfiguration): void {
  if (configuration.overpassUrl) setOverpassUrl(configuration.overpassUrl);
  setManifestDataSources(configuration.context.manifest.dataSources ?? []);
  setLogger(configuration.context.log);
}

const runtimeConfiguration = createStagedRuntimeValue(applyRuntimeConfiguration);

export function setup(ctx: IntegrationContext): void {
  stageRuntimeGeneration(ctx, parkingRuntime, ctx, () => {
    runtimeConfiguration.stage(parkingRuntime, {
      context: ctx,
      overpassUrl: ctx.getRequiredService("overpass")?.url,
    });
    ctx.registerPoiSources(declarePoiSources());
    ctx.registerMobilityDataSource(parkingProvider);
    registerPlaceResolver(parkingProvider.id, createDataSourceResolver(parkingProvider));
  });
}
