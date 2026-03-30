import type { IntegrationContext } from "@openmapx/core";
import { mapillaryPhotoProvider } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerProvider("photos", mapillaryPhotoProvider);
}
