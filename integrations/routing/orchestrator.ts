import type { TravelMode } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import type { RoutingProvider } from "./types.js";

export interface ResolvedProvider {
  provider: RoutingProvider;
  integrationId: string;
}

/**
 * Per-mode provider preference, by `provider.id`. Driving prefers Valhalla's
 * `auto` costing: it returns localized, voice-optimized instructions
 * (`verbal_*`), roundabout exit counts and lane data that OSRM does not, for a
 * better turn-by-turn experience. OSRM stays in the chain as a fast fallback.
 * Modes without an entry keep integration-registration order.
 */
const MODE_PROVIDER_PREFERENCE: Partial<Record<TravelMode, string[]>> = {
  driving: ["valhalla", "osrm"],
};

/**
 * Stable-sort matching providers by the mode's preference: preferred ids first
 * (in listed order), everything else keeps registration order.
 */
function orderByPreference(entries: ResolvedProvider[], mode: TravelMode): ResolvedProvider[] {
  const pref = MODE_PROVIDER_PREFERENCE[mode];
  if (!pref) return entries;
  const rank = (id: string): number => {
    const i = pref.indexOf(id);
    return i === -1 ? pref.length : i;
  };
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry.provider.id) - rank(b.entry.provider.id) || a.index - b.index)
    .map(({ entry }) => entry);
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
    return getRoutingProviders(mode, filters)[0] ?? null;
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
    return orderByPreference(
      collectProviders().filter((e) => matches(e.provider, mode, filters)),
      mode,
    );
  }

  function getOptimizeProvider(
    mode: TravelMode,
    filters: ProviderFilters = {},
  ): ResolvedProvider | null {
    const providers = orderByPreference(collectProviders(), mode);

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
