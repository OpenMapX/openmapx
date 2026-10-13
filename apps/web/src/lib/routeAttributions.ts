import type { Route } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { contributorsForRecordFields } from "@openmapx/mobility-core/contributors";
import type { ProviderMetaResolver } from "@/lib/attributionForProviders";
import { servedAttributions } from "@/lib/servedAttributions";

/** Credits the displayed route snapshot, or its selected displayed fields.
 * Named legacy backend IDs remain supported without expanding a missing or
 * unknown identity into a multi-backend provider catalogue.
 */
export function routeAttributions(
  registry: ProviderMetaResolver,
  provider: string | null | undefined,
  route: Pick<Route, "sourceIds" | "contributors" | "fieldContributors"> | null | undefined,
  displayedFields?: readonly string[],
): Attribution[] {
  if (route?.fieldContributors !== undefined && displayedFields)
    return contributorsForRecordFields(route, displayedFields);
  return route
    ? servedAttributions(registry, [{ ...route, provider, sourceIds: route.sourceIds ?? [] }])
    : [];
}
