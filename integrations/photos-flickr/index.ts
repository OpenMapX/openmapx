import type { IntegrationContext } from "@openmapx/core";
import { flickrPhotoProvider } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerProvider("photos", flickrPhotoProvider);
}
