import type { IntegrationContext } from "@openmapx/integration-framework";
import { attribution } from "./attributions.js";
import { setupCloud } from "./cloud.js";
import { setupLocal } from "./local.js";

export function setup(ctx: IntegrationContext): void {
  attribution.set(ctx.manifest.dataSources ?? []);
  setupLocal(ctx);
  setupCloud(ctx);
}
