import type { IntegrationContext } from "@openmapx/core";
import { osrmService, setOsrmUrl } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  const resolved = ctx.getRequiredService("osrm");
  const url =
    resolved?.url ??
    (ctx.config.endpoint as string | undefined) ??
    process.env.OSRM_URL ??
    "https://router.project-osrm.org";

  setOsrmUrl(url);

  ctx.registerProvider("routing", osrmService);
}
