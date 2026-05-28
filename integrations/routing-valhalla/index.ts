import type { IntegrationContext } from "@openmapx/integration-framework";
import { setValhallaApiKey, setValhallaUrl, valhallaService } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  const resolved = ctx.getRequiredService("valhalla");
  const url =
    resolved?.url ?? (ctx.config.endpoint as string | undefined) ?? "https://api.stadiamaps.com";

  setValhallaUrl(url);
  setValhallaApiKey((ctx.config.apiKey as string | undefined) ?? process.env.VALHALLA_API_KEY);

  ctx.registerRoutingProvider(valhallaService);
}
