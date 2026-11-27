import {
  collectOrderedProviders,
  type HealthCheckResult,
  type IntegrationContext,
  type RoutingProvider,
} from "@openmapx/integration-framework";

/**
 * The overlay makes no request of its own: street isochrones are served by
 * the first routing engine in the operator's order that offers them. So it is
 * healthy exactly when such an engine is loaded; that engine's own checks
 * report whether its upstream answers. Without such an engine the operator has
 * chosen not to load one, which is a configuration state rather than an outage.
 */
export function setup(ctx: IntegrationContext): void {
  ctx.registerHealthCheck(async (): Promise<HealthCheckResult> => {
    const servesIsochrones = collectOrderedProviders<RoutingProvider>(ctx, "routing").some(
      ({ provider }) => typeof provider.getIsochrone === "function",
    );
    return servesIsochrones
      ? { status: "up" }
      : { status: "unconfigured", error: "No loaded routing engine offers isochrones" };
  });
}
