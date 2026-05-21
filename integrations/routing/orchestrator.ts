import type { TravelMode } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
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

  /**
   * Optional filters applied on top of the mode match. `requireTimeAware`
   * restricts the chain to providers that honour `departAt`/`arriveBy`; the
   * `/directions` and `/directions/optimize` handlers set it whenever the
   * caller pins a wall-clock so we don't silently return an untimed route
   * from a time-agnostic engine like OSRM.
   */
  interface ProviderFilters {
    requireTimeAware?: boolean;
  }

  function matches(provider: RoutingProvider, mode: TravelMode, filters: ProviderFilters): boolean {
    if (!provider.supportedModes.includes(mode)) return false;
    if (filters.requireTimeAware && !provider.supportsTimeAware) return false;
    return true;
  }

  function getRoutingProvider(
    mode: TravelMode,
    filters: ProviderFilters = {},
  ): ResolvedProvider | null {
    for (const entry of collectProviders()) {
      if (matches(entry.provider, mode, filters)) return entry;
    }
    return null;
  }

  /**
   * Returns every provider that supports the requested mode (and any extra
   * filters), in registration order. The route handler iterates this chain so
   * that a single provider's outage (e.g. the public OSRM demo returning 502)
   * falls back to the next compatible provider instead of failing the request.
   */
  function getRoutingProviders(
    mode: TravelMode,
    filters: ProviderFilters = {},
  ): ResolvedProvider[] {
    return collectProviders().filter((e) => matches(e.provider, mode, filters));
  }

  function getOptimizeProvider(
    mode: TravelMode,
    filters: ProviderFilters = {},
  ): ResolvedProvider | null {
    const providers = collectProviders();

    for (const entry of providers) {
      if (entry.provider.optimizeRoute && matches(entry.provider, mode, filters)) return entry;
    }

    // Cross-mode fallback only kicks in when no time-awareness is required —
    // returning a non-matching-mode provider for a timed request would
    // re-introduce the silent-drop bug.
    if (!filters.requireTimeAware) {
      for (const entry of providers) {
        if (entry.provider.optimizeRoute) return entry;
      }
    }

    return null;
  }

  function getMatchProvider(mode: TravelMode): ResolvedProvider | null {
    const providers = collectProviders();
    for (const entry of providers) {
      if (entry.provider.getMatch && entry.provider.supportedModes.includes(mode)) return entry;
    }
    return null;
  }

  return { getRoutingProvider, getRoutingProviders, getOptimizeProvider, getMatchProvider };
}
