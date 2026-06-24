import type { IntegrationContext } from "@openmapx/integration-framework";
import { setValhallaApiKey, setValhallaUrl, valhallaService } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  const resolved = ctx.getRequiredService("valhalla");
  // Resolution order: the wired self-hosted `valhalla` service, then an explicit
  // config endpoint, then the VALHALLA_URL env var, and only as a last resort the
  // hosted Stadia default. Honoring VALHALLA_URL here means a deployment that
  // points at its own engine never silently falls back to Stadia if the service
  // capability fails to resolve.
  const url =
    resolved?.url ??
    (ctx.config.endpoint as string | undefined) ??
    process.env.VALHALLA_URL ??
    "https://api.stadiamaps.com";

  setValhallaUrl(url);
  setValhallaApiKey((ctx.config.apiKey as string | undefined) ?? process.env.VALHALLA_API_KEY);

  ctx.registerRoutingProvider(valhallaService);
}
