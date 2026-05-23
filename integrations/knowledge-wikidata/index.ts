import type { IntegrationContext } from "@openmapx/integration-framework";
import { wikidataSource } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerKnowledgeProvider(wikidataSource);
}
