import {
  type IntegrationContext,
  resolveIntegrationContributors,
  withRoutingContributors,
} from "@openmapx/integration-framework";
import { createBrouterProvider } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  const resolved = ctx.getRequiredService("brouter");
  const endpoint = resolved?.enabled
    ? resolved.url
    : typeof ctx.config.endpoint === "string"
      ? ctx.config.endpoint.trim()
      : undefined;
  if (!endpoint) return;
  ctx.registerRoutingProvider(
    withRoutingContributors(createBrouterProvider(ctx, endpoint), () =>
      resolveIntegrationContributors(ctx, ["brouter"]),
    ),
  );
}
