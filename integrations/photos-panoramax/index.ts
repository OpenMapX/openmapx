import type { IntegrationContext } from "@openmapx/integration-framework";
import { panoramaxPhotoProvider } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerProvider("photos", panoramaxPhotoProvider);
}
