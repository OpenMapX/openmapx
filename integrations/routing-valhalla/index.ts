import {
  type IntegrationContext,
  resolveIntegrationContributors,
  withRoutingContributors,
} from "@openmapx/integration-framework";
import { createValhallaService, type ValhallaSettings, valhallaSourceIds } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  let settings: ValhallaSettings = { bidirectionalAlternates: true };
  ctx.onActivate(() => {
    settings = {
      // The self-hosted service, the `endpoint` setting, VALHALLA_URL, then Stadia.
      url: ctx.resolvePlatformEndpoint("valhalla")?.url,
      apiKey: (ctx.config.apiKey as string | undefined) || undefined,
      // Defaults on: only an explicit `false` from config disables it.
      bidirectionalAlternates: ctx.config.bidirectionalAlternates !== false,
    };
  });

  ctx.registerRoutingProvider(
    withRoutingContributors(
      createValhallaService(ctx.http, () => settings),
      () => resolveIntegrationContributors(ctx, valhallaSourceIds(settings.url)),
    ),
  );
}
