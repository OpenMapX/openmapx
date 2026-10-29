import {
  capturePhotoProviderContributors,
  type IntegrationContext,
} from "@openmapx/integration-framework";
import { mapillaryPhotoProvider, setMapillaryAccessToken } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.onActivate(() => setMapillaryAccessToken(ctx.config.accessToken as string | undefined));
  ctx.registerPhotoProvider(capturePhotoProviderContributors(ctx, mapillaryPhotoProvider));
}
