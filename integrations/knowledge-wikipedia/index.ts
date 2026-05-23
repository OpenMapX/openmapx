import type { IntegrationContext } from "@openmapx/integration-framework";
import { wikipediaSource } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerKnowledgeProvider(wikipediaSource);
}
