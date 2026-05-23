import type { IntegrationContext } from "@openmapx/integration-framework";
import { wikimediaProvider } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerPhotoProvider(wikimediaProvider);
}
