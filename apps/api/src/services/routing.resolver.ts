import type { RoutingProvider, TravelMode } from "@openmapx/core";
import { getIntegrationsByDomain } from "../integration-host.js";

function collectProviders(): RoutingProvider[] {
  const routingIntegrations = getIntegrationsByDomain("routing");
  const providers: RoutingProvider[] = [];

  for (const integration of routingIntegrations) {
    const registered = (integration.providers.get("routing") ?? []) as RoutingProvider[];
    providers.push(...registered);
  }

  return providers;
}

/**
 * Returns a routing provider that supports the given travel mode.
 * Providers are resolved dynamically from the integration framework.
 */
export function getRoutingProvider(mode: TravelMode): RoutingProvider | null {
  const providers = collectProviders();

  for (const provider of providers) {
    if (provider.supportedModes.includes(mode)) {
      return provider;
    }
  }

  return null;
}

/**
 * Returns a routing provider that supports optimizeRoute for the given mode.
 * Falls back through all providers until one with optimizeRoute is found.
 */
export function getOptimizeProvider(mode: TravelMode): RoutingProvider | null {
  const providers = collectProviders();

  for (const provider of providers) {
    if (provider.optimizeRoute && provider.supportedModes.includes(mode)) {
      return provider;
    }
  }

  // If no provider supports the exact mode, try any with optimizeRoute
  for (const provider of providers) {
    if (provider.optimizeRoute) {
      return provider;
    }
  }

  return null;
}
