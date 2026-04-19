import type { IntegrationContext } from "@openmapx/core";
import { flickrPhotoProvider, setFlickrApiKey } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  setFlickrApiKey(ctx.config.apiKey as string | undefined);
  ctx.registerProvider("photos", flickrPhotoProvider);
}
