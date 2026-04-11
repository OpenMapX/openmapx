import type { IntegrationContext, TravelMode } from "@openmapx/core";
import type { RoutingProvider } from "./types.js";

export interface ResolvedProvider {
  provider: RoutingProvider;
  integrationId: string;
}

export function createRoutingOrchestrator(ctx: IntegrationContext) {
  function collectProviders(): ResolvedProvider[] {
    const routingIntegrations = ctx.getIntegrationsByDomain("routing");
    const resolved: ResolvedProvider[] = [];

    for (const integration of routingIntegrations) {
      const registered = (integration.providers.get("routing") ?? []) as RoutingProvider[];
      for (const provider of registered) {
        resolved.push({ provider, integrationId: integration.id });
      }
    }

    return resolved;
  }

  function getRoutingProvider(mode: TravelMode): ResolvedProvider | null {
    for (const entry of collectProviders()) {
      if (entry.provider.supportedModes.includes(mode)) return entry;
    }
    return null;
  }

  function getOptimizeProvider(mode: TravelMode): ResolvedProvider | null {
    const providers = collectProviders();

    for (const entry of providers) {
      if (entry.provider.optimizeRoute && entry.provider.supportedModes.includes(mode))
        return entry;
    }

    for (const entry of providers) {
      if (entry.provider.optimizeRoute) return entry;
    }

    return null;
  }

  return { getRoutingProvider, getOptimizeProvider };
}
