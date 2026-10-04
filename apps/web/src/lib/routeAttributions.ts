import type { Route } from "@openmapx/core";
import { dataSourceToAttribution } from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { ProviderMetaResolver } from "@/lib/attributionForProviders";

/**
 * Credits for a drawn route: the routing provider's declared sources, narrowed
 * to the `route.sourceIds` its engine reported. An integration that can talk to
 * several backends (routing-valhalla: self-hosted vs Stadia Maps) thereby
 * credits only the one that computed the route. Resolution stays within the
 * provider's own manifest, since other integrations may reuse a sourceId.
 */
export function routeAttributions(
  registry: ProviderMetaResolver,
  provider: string | null | undefined,
  route: Pick<Route, "sourceIds"> | null | undefined,
): Attribution[] {
  if (!provider) return [];
  const declared = registry.get(provider)?.dataSources ?? [];
  const served = route?.sourceIds;
  const credited =
    served && served.length > 0 ? declared.filter((ds) => served.includes(ds.sourceId)) : declared;
  return credited.map(dataSourceToAttribution);
}
