import type { IntegrationContext } from "@openmapx/integration-framework";
import {
  maptilerDailyBudget,
  sharedAdmissionOf,
} from "@openmapx/integration-framework/provider-daily-budget";
import { createMaptilerGeocodingService, resolveMaptilerApiKey } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  let apiKey: string | undefined;
  ctx.onActivate(() => {
    apiKey = resolveMaptilerApiKey(ctx.config.apiKey as string | undefined);
  });
  ctx.registerGeocodingProvider(
    createMaptilerGeocodingService({
      http: ctx.http,
      apiKey: () => apiKey,
      budget: maptilerDailyBudget(sharedAdmissionOf(ctx.upstreamRuntime)),
      log: ctx.log,
    }),
  );
}
