import type { IntegrationContext } from "@openmapx/core";
import { fuelProvider } from "./providers/provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerProvider("data-source", fuelProvider);
}
