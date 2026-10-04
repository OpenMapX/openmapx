import type { Route } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { ProviderMetaResolver } from "@/lib/attributionForProviders";
import { servedAttributions } from "@/lib/servedAttributions";

/**
 * Credits for a drawn route: the routing provider's declared sources, narrowed
 * to the `route.sourceIds` its engine reported, so routing-valhalla credits
 * only the backend (self-hosted vs Stadia Maps) that computed the route.
 */
export function routeAttributions(
  registry: ProviderMetaResolver,
  provider: string | null | undefined,
  route: Pick<Route, "sourceIds"> | null | undefined,
): Attribution[] {
  return servedAttributions(registry, [{ provider, sourceIds: route?.sourceIds }]);
}
