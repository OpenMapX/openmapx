import type { IntegrationContext } from "@openmapx/integration-framework";
import { setValhallaUrl, valhallaService } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  const resolved = ctx.getRequiredService("valhalla");
  const url =
    resolved?.url ??
    (ctx.config.endpoint as string | undefined) ??
    "https://valhalla1.openstreetmap.de";

  setValhallaUrl(url);

  ctx.registerRoutingProvider(valhallaService);
}
