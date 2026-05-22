import type { IntegrationContext } from "@openmapx/integration-framework";
import { setupCloud } from "./cloud.js";
import { setupLocal } from "./local.js";

export function setup(ctx: IntegrationContext): void {
  setupLocal(ctx);
  setupCloud(ctx);
}
