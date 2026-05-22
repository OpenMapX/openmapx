import type { IntegrationContext } from "@openmapx/integration-framework";
import { setupCloud } from "./cloud.js";
import { getFeedProviders, setupLocal } from "./local.js";

export { getFeedProviders };

export function setup(ctx: IntegrationContext): void {
  setupLocal(ctx);
  setupCloud(ctx);
}
