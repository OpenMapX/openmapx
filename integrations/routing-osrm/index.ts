import type { IntegrationContext } from "@openmapx/integration-framework";
import { osrmService, setOsrmUrl } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  const resolved = ctx.getRequiredService("osrm");
  const url =
    resolved?.url ??
    (ctx.config.endpoint as string | undefined) ??
    "https://router.project-osrm.org";

  setOsrmUrl(url);

  ctx.registerProvider("routing", osrmService);
}
