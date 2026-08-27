import type { IntegrationContext } from "@openmapx/integration-framework";
import { flickrPhotoProvider, setFlickrApiKey } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.onActivate(() => setFlickrApiKey(ctx.config.apiKey as string | undefined));
  ctx.registerPhotoProvider(flickrPhotoProvider);
}
