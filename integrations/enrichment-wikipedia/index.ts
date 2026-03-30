import type { IntegrationContext } from "@openmapx/core";
import { wikipediaEnricher } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerProvider("enrichment", wikipediaEnricher);
}
