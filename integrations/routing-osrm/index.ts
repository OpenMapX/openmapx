import type { IntegrationContext } from "@openmapx/core";
import { osrmService } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerProvider("routing", osrmService);
}
