import type { IntegrationContext } from "@openmapx/core";
import { photonService, setPhotonUrl } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  const resolved = ctx.getRequiredService("photon");
  const url =
    resolved?.url ?? (ctx.config.endpoint as string | undefined) ?? "https://photon.komoot.io";

  setPhotonUrl(url);

  ctx.registerProvider("geocoding", photonService);
}
