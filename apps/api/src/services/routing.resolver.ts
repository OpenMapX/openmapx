import type { RoutingProvider, TravelMode } from "@openmapx/core";
import { getIntegrationsByDomain } from "../integration-host.js";

interface ResolvedProvider {
  provider: RoutingProvider;
  integrationId: string;
}

function collectProviders(): ResolvedProvider[] {
  const routingIntegrations = getIntegrationsByDomain("routing");
  const resolved: ResolvedProvider[] = [];

  for (const integration of routingIntegrations) {
    const registered = (integration.providers.get("routing") ?? []) as RoutingProvider[];
    for (const provider of registered) {
      resolved.push({ provider, integrationId: integration.id });
    }
  }

  return resolved;
}

/**
 * Returns a routing provider that supports the given travel mode,
 * together with the integration ID it belongs to.
 */
export function getRoutingProvider(mode: TravelMode): ResolvedProvider | null {
  const providers = collectProviders();

  for (const entry of providers) {
    if (entry.provider.supportedModes.includes(mode)) {
      return entry;
    }
  }

  return null;
}

/**
 * Returns a routing provider that supports optimizeRoute for the given mode.
 * Falls back through all providers until one with optimizeRoute is found.
 */
export function getOptimizeProvider(mode: TravelMode): ResolvedProvider | null {
  const providers = collectProviders();

  for (const entry of providers) {
    if (entry.provider.optimizeRoute && entry.provider.supportedModes.includes(mode)) {
      return entry;
    }
  }

  // If no provider supports the exact mode, try any with optimizeRoute
  for (const entry of providers) {
    if (entry.provider.optimizeRoute) {
      return entry;
    }
  }

  return null;
}
