import type { IntegrationContext } from "@openmapx/integration-framework";
import { photonService, setPhotonUrl } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.onActivate(() => setPhotonUrl(ctx.resolvePlatformEndpoint("photon")?.url));

  ctx.registerGeocodingProvider(photonService);
}
