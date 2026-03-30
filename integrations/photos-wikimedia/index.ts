import type { IntegrationContext } from "@openmapx/core";
import { wikimediaGeoProvider } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerProvider("photos", wikimediaGeoProvider);
}
