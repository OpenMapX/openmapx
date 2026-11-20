import {
  capturePhotoProviderContributors,
  type IntegrationContext,
} from "@openmapx/integration-framework";
import { createFlickrPhotoProvider } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  let apiKey: string | undefined;
  ctx.onActivate(() => {
    const configured = ctx.config.apiKey as string | undefined;
    apiKey = configured && configured.length > 0 ? configured : undefined;
  });
  ctx.registerPhotoProvider(
    capturePhotoProviderContributors(
      ctx,
      createFlickrPhotoProvider({ http: ctx.http, apiKey: () => apiKey }),
    ),
  );
}
