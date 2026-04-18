import type { IntegrationContext } from "@openmapx/core";
import { mangroveProvider } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerProvider("reviews", mangroveProvider);
}
