import type { IntegrationContext } from "@openmapx/core";
import { wikimediaCommonsEnricher } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerProvider("enrichment", wikimediaCommonsEnricher);
}
