import type { IntegrationContext } from "@openmapx/integration-framework";
import { resolveEndpoint } from "@openmapx/integration-geocoding/endpoint";
import { photonService, setPhotonUrl } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.onActivate(() => setPhotonUrl(resolveEndpoint(ctx, "photon", "https://photon.komoot.io")));

  ctx.registerGeocodingProvider(photonService);
}
