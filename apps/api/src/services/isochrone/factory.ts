import { collectOrderedProviders, type RoutingProvider } from "@openmapx/integration-framework";
import { getIntegrationsByDomain, getProviderOrder } from "../../integration-host.js";

/**
 * The first routing engine in the operator's order that offers isochrones,
 * or null when none does. The method is called on the registered provider
 * itself, so the engine's scope and call deadline apply.
 */
export function getIsochroneProvider(): {
  integrationId: string;
  isochrone: NonNullable<RoutingProvider["getIsochrone"]>;
} | null {
  for (const { integrationId, provider } of collectOrderedProviders<RoutingProvider>(
    { getProviderOrder, getIntegrationsByDomain },
    "routing",
  )) {
    const getIsochrone = provider.getIsochrone;
    if (typeof getIsochrone !== "function") continue;
    return {
      integrationId,
      isochrone: (origin, mode, contourMinutes) =>
        getIsochrone.call(provider, origin, mode, contourMinutes),
    };
  }
  return null;
}
