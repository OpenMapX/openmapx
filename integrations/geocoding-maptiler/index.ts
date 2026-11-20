import type { IntegrationContext } from "@openmapx/integration-framework";
import {
  maptilerDailyBudget,
  sharedAdmissionOf,
} from "@openmapx/integration-framework/provider-daily-budget";
import { createMaptilerGeocodingService, resolveMaptilerApiKey } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  let resolved: ReturnType<typeof resolveMaptilerApiKey>;
  ctx.onActivate(() => {
    resolved = resolveMaptilerApiKey(ctx.config.apiKey as string | undefined);
  });
  const sharedBudget = maptilerDailyBudget(sharedAdmissionOf(ctx.upstreamRuntime));
  ctx.registerGeocodingProvider(
    createMaptilerGeocodingService({
      http: ctx.http,
      apiKey: () => resolved?.key,
      budget: () => (resolved?.shared ? sharedBudget : null),
      log: ctx.log,
    }),
  );
}
