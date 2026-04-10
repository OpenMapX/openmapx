import type { IntegrationContext } from "@openmapx/core";
import { wikimediaProvider } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerProvider("photos", wikimediaProvider);
}
