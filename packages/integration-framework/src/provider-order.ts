import type { IntegrationContext } from "./context";
import type { ProviderDomain } from "./contracts/provider-shapes";
import type { LoadedIntegration } from "./loader";

/**
 * The integration whose `providerOrder` setting orders each domain. The order
 * belongs to that integration's stored configuration whether or not it is
 * enabled: the site orchestrators declare only `data-source`, and transit
 * consumes `live-transit` while `overlay-live-transit` may be off. A domain
 * whose providers are all merged, or selected by id, has none.
 */
export const ORCHESTRATOR_BY_DOMAIN: Record<ProviderDomain, string | null> = {
  routing: "routing",
  weather: "weather",
  geocoding: "geocoding",
  "poi-search": "poi-search",
  "road-conditions": "road-conditions",
  "fuel-stations": "fuel",
  "parking-sites": "parking",
  "charging-sites": "ev-charging",
  cameras: "webcam",
  "message-signs": "message-signs",
  "road-weather": "road-weather",
  "service-vehicles": "road-maintenance",
  "border-crossings": "border-crossings",
  photos: "photos",
  reviews: "reviews",
  transit: "transit",
  "live-transit": "overlay-live-transit",
  "search-suggestions": "search-suggestions",
  "ride-hailing": "ride-hailing",
  "air-quality": "air-quality",
  "data-source": "data-source",
  "landmark-models": "landmark-models",
  hazards: null,
  knowledge: null,
  "gtfs-catalog": null,
  "street-level-imagery": null,
};

/**
 * What happens to an integration the operator has not listed. Geocoding's list
 * is a selection, so a newly installed geocoder is only offered; everywhere
 * else it joins after the listed ones.
 */
export const UNLISTED_BY_DOMAIN: Record<ProviderDomain, "append" | "exclude"> = {
  routing: "append",
  weather: "append",
  geocoding: "exclude",
  "poi-search": "append",
  "road-conditions": "append",
  "fuel-stations": "append",
  "parking-sites": "append",
  "charging-sites": "append",
  cameras: "append",
  "message-signs": "append",
  "road-weather": "append",
  "service-vehicles": "append",
  "border-crossings": "append",
  photos: "append",
  reviews: "append",
  transit: "append",
  "live-transit": "append",
  "search-suggestions": "append",
  "ride-hailing": "append",
  "air-quality": "append",
  "data-source": "append",
  "landmark-models": "append",
  hazards: "append",
  knowledge: "append",
  "gtfs-catalog": "append",
  "street-level-imagery": "append",
};

/** The orchestrator integration of `domain`, or null for an unknown domain or one without. */
export function orchestratorOf(domain: string): string | null {
  return Object.hasOwn(ORCHESTRATOR_BY_DOMAIN, domain)
    ? ORCHESTRATOR_BY_DOMAIN[domain as ProviderDomain]
    : null;
}

/** How `domain` treats unlisted integrations; `"append"` for an unknown domain. */
export function unlistedRuleOf(domain: string): "append" | "exclude" {
  return Object.hasOwn(UNLISTED_BY_DOMAIN, domain)
    ? UNLISTED_BY_DOMAIN[domain as ProviderDomain]
    : "append";
}

/** A `providerOrder` value as configuration delivers it, reduced to its string entries. */
export function readProviderOrder(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export interface OrderedProvider<T> {
  integrationId: string;
  provider: T;
}

/** First position of each listed integration id; later repeats do not move it. */
function rankOf(order: readonly string[]): Map<string, number> {
  const rank = new Map<string, number>();
  for (const [index, id] of order.entries()) if (!rank.has(id)) rank.set(id, index);
  return rank;
}

/**
 * The providers of `domain` in the operator's order: those of listed
 * integrations first, in list order, then the others sorted by `fallback`
 * (registry order when it is absent or ties), or none of the others when
 * `unlisted` is `"exclude"`. A listed integration that is not loaded is
 * skipped. Providers of one integration keep their registration order among
 * the listed ones. The registered objects are returned as they are; they must
 * not be copied, since their data members live on their prototype.
 */
export function collectOrderedProviders<T>(
  ctx: IntegrationContext,
  domain: ProviderDomain,
  options: {
    fallback?: (a: OrderedProvider<T>, b: OrderedProvider<T>) => number;
    unlisted?: "append" | "exclude";
  } = {},
): OrderedProvider<T>[] {
  const rank = rankOf(ctx.getProviderOrder(domain));
  const entries = ctx.getIntegrationsByDomain(domain).flatMap((integration) =>
    ((integration.providers.get(domain) ?? []) as T[]).map((provider) => ({
      integrationId: integration.id,
      provider,
    })),
  );
  const listed = entries
    .filter((entry) => rank.has(entry.integrationId))
    .sort((a, b) => (rank.get(a.integrationId) ?? 0) - (rank.get(b.integrationId) ?? 0));
  if (options.unlisted === "exclude") return listed;
  const rest = entries.filter((entry) => !rank.has(entry.integrationId));
  if (options.fallback) rest.sort(options.fallback);
  return [...listed, ...rest];
}

/**
 * Each integration with a provider of `domain`, once: the listed ones in list
 * order, then the others in registry order, flagged by whether they are
 * listed. Whether unlisted ones are used is the domain's rule.
 */
export function effectiveProviderOrder(
  order: readonly string[],
  integrations: readonly Pick<LoadedIntegration, "id" | "providers">[],
  domain: string,
): Array<{ integrationId: string; listed: boolean }> {
  const rank = rankOf(order);
  const serving = integrations
    .filter((integration) => (integration.providers.get(domain)?.length ?? 0) > 0)
    .map((integration) => integration.id)
    .filter((id, index, ids) => ids.indexOf(id) === index);
  const listed = serving
    .filter((id) => rank.has(id))
    .sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
  return [
    ...listed.map((integrationId) => ({ integrationId, listed: true })),
    ...serving
      .filter((id) => !rank.has(id))
      .map((integrationId) => ({ integrationId, listed: false })),
  ];
}

/**
 * The integration ids whose providers `domain` uses, in order: what a cache
 * key covers when its answer depends on which providers serve. Unlisted
 * integrations count only where the domain appends them.
 */
export function effectiveIntegrationIds(
  source: Pick<IntegrationContext, "getProviderOrder" | "getIntegrationsByDomain">,
  domain: string,
): string[] {
  const include = unlistedRuleOf(domain) === "append";
  return effectiveProviderOrder(
    source.getProviderOrder(domain),
    source.getIntegrationsByDomain(domain),
    domain,
  )
    .filter((entry) => entry.listed || include)
    .map((entry) => entry.integrationId);
}
