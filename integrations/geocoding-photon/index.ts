import type { IntegrationContext } from "@openmapx/core";
import { photonService } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerProvider("geocoding", photonService);
}
