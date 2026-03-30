import type { IntegrationContext } from "@openmapx/core";
import { valhallaService } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerProvider("routing", valhallaService);
}
