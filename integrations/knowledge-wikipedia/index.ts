import type { IntegrationContext } from "@openmapx/core";
import { wikipediaSource } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerProvider("knowledge", wikipediaSource);
}
