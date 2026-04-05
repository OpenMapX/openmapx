import type { IntegrationContext } from "@openmapx/core";
import { wikidataEnricher } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerProvider("enrichment", wikidataEnricher);
}
