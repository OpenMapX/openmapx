import type { IntegrationContext } from "@openmapx/core";
import { wikidataSource } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerProvider("knowledge", wikidataSource);
}
