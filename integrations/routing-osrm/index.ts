import {
  type IntegrationContext,
  resolveIntegrationContributors,
  withRoutingContributors,
} from "@openmapx/integration-framework";
import { osrmService, setOsrmUrl } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.onActivate(() => setOsrmUrl(ctx.resolvePlatformEndpoint("osrm")?.url));

  ctx.registerRoutingProvider(
    withRoutingContributors(osrmService, () => resolveIntegrationContributors(ctx, ["osrm"])),
  );
}
