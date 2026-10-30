import {
  type IntegrationContext,
  resolveIntegrationContributors,
  withRoutingContributors,
} from "@openmapx/integration-framework";
import {
  setValhallaApiKey,
  setValhallaBidirectionalAlternates,
  setValhallaUrl,
  valhallaService,
  valhallaSourceIds,
} from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.onActivate(() => {
    // The self-hosted service, the `endpoint` setting, VALHALLA_URL, then Stadia.
    setValhallaUrl(ctx.resolvePlatformEndpoint("valhalla")?.url);
    setValhallaApiKey(ctx.config.apiKey as string | undefined);
    // Defaults on: only an explicit `false` from config disables it.
    setValhallaBidirectionalAlternates(ctx.config["bidirectional-alternates"] !== false);
  });

  ctx.registerRoutingProvider(
    withRoutingContributors(valhallaService, () =>
      resolveIntegrationContributors(ctx, valhallaSourceIds()),
    ),
  );
}
