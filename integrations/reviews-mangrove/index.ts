import type { IntegrationContext } from "@openmapx/integration-framework";
import { mangroveProvider } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerReviewProvider(mangroveProvider);
}
