import type { IntegrationContext } from "@openmapx/integration-framework";
import { setValhallaApiKey, setValhallaUrl, valhallaService } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  const resolved = ctx.getRequiredService("valhalla");
  // Resolution order: the wired self-hosted `valhalla` service, then an explicit
  // config endpoint (INTEGRATION_ROUTING_VALHALLA_ENDPOINT), and only as a last
  // resort the hosted Stadia default.
  const url =
    resolved?.url ?? (ctx.config.endpoint as string | undefined) ?? "https://api.stadiamaps.com";

  setValhallaUrl(url);
  setValhallaApiKey(ctx.config.apiKey as string | undefined);

  ctx.registerRoutingProvider(valhallaService);
}
