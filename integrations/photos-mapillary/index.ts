import type { IntegrationContext } from "@openmapx/integration-framework";
import { mapillaryPhotoProvider, setMapillaryAccessToken } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  setMapillaryAccessToken(ctx.config.accessToken as string | undefined);
  ctx.registerProvider("photos", mapillaryPhotoProvider);
}
