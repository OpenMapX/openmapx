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

/** The most entries a `providerOrder` holds: the `maxItems` every orchestrator manifest declares. */
const PROVIDER_ORDER_MAX_ENTRIES = 64;

/**
 * A `providerOrder` value as configuration delivers it: its string entries,
 * each once, at most 64 of them. The environment override is not checked
 * against the manifest's `maxItems`, so the cut is made here, and `onCut`
 * hears the length it was cut from.
 */
export function readProviderOrder(
  value: unknown,
  onCut?: (entries: number) => void,
): readonly string[] {
  if (!Array.isArray(value)) return [];
  const ids = [...new Set(value.filter((entry): entry is string => typeof entry === "string"))];
  if (ids.length <= PROVIDER_ORDER_MAX_ENTRIES) return ids;
  onCut?.(ids.length);
  return ids.slice(0, PROVIDER_ORDER_MAX_ENTRIES);
}

export interface OrderedProvider<T> {
  integrationId: string;
  provider: T;
}

type ProviderComparator = (a: OrderedProvider<unknown>, b: OrderedProvider<unknown>) => number;

function member(provider: unknown, key: string): unknown {
  return typeof provider === "object" && provider !== null
    ? (provider as Record<string, unknown>)[key]
    : undefined;
}

function ascending(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function priorityOf(provider: unknown): number {
  const priority = member(provider, "priority");
  return typeof priority === "number" && !Number.isNaN(priority)
    ? priority
    : Number.POSITIVE_INFINITY;
}

function idOf(provider: unknown): string {
  const id = member(provider, "id");
  return typeof id === "string" ? id : "";
}

/** Lower `priority` first; a provider without a numeric one after those with one. */
export function compareByPriority(a: unknown, b: unknown): number {
  return ascending(priorityOf(a), priorityOf(b));
}

const TRANSIT_ROLE_RANK: Readonly<Record<string, number>> = {
  baseline: 0,
  regional: 1,
  fallback: 2,
  enrichment: 3,
};

function transitRoleRank(provider: unknown): number {
  const role = member(provider, "role");
  return typeof role === "string" && Object.hasOwn(TRANSIT_ROLE_RANK, role)
    ? (TRANSIT_ROLE_RANK[role] ?? Number.POSITIVE_INFINITY)
    : Number.POSITIVE_INFINITY;
}

/**
 * Transit's planning policy: role (baseline, regional, fallback, enrichment),
 * then priority, then provider id.
 */
export function compareTransitProviders(a: unknown, b: unknown): number {
  return (
    ascending(transitRoleRank(a), transitRoleRank(b)) ||
    compareByPriority(a, b) ||
    idOf(a).localeCompare(idOf(b))
  );
}

/** Priority, then provider id, then integration id: air quality's provider order. */
export function compareAirQualityProviders(
  a: OrderedProvider<unknown>,
  b: OrderedProvider<unknown>,
): number {
  return (
    compareByPriority(a.provider, b.provider) ||
    idOf(a.provider).localeCompare(idOf(b.provider)) ||
    a.integrationId.localeCompare(b.integrationId)
  );
}

/** Street-level imagery sources, sorted after the other photo sources. */
const LATE_PHOTO_PROVIDER_IDS = new Set(["mapillary", "panoramax"]);

/** Photo sources in registration order, street-level imagery after the others. */
export function comparePhotoProviders(a: unknown, b: unknown): number {
  return ascending(
    LATE_PHOTO_PROVIDER_IDS.has(idOf(a)) ? 1 : 0,
    LATE_PHOTO_PROVIDER_IDS.has(idOf(b)) ? 1 : 0,
  );
}

const byProvider =
  (compare: (a: unknown, b: unknown) => number): ProviderComparator =>
  (a, b) =>
    compare(a.provider, b.provider);

/**
 * How each domain orders providers the operator has not listed: the order its
 * orchestrator used before an operator could set one, which those
 * orchestrators keep using through the same comparators. A domain not named
 * here keeps registry order.
 */
const FALLBACK_BY_DOMAIN: Partial<Record<ProviderDomain, ProviderComparator>> = {
  routing: byProvider(compareByPriority),
  weather: byProvider(compareByPriority),
  "live-transit": byProvider(compareByPriority),
  transit: byProvider(compareTransitProviders),
  "air-quality": compareAirQualityProviders,
  photos: byProvider(comparePhotoProviders),
};

/** First position of each listed integration id; later repeats do not move it. */
function rankOf(order: readonly string[]): Map<string, number> {
  const rank = new Map<string, number>();
  for (const [index, id] of order.entries()) if (!rank.has(id)) rank.set(id, index);
  return rank;
}

interface ServedProvider<T> extends OrderedProvider<T> {
  listed: boolean;
  /** The provider's id, or its position among its integration's registrations. */
  key: string | number;
}

/**
 * Every provider of `domain` in the order it is served: those of listed
 * integrations first, in list order, keeping one integration's registration
 * order; then the others by the domain's fallback, a stable sort, so registry
 * order breaks ties. A listed integration that is not loaded is skipped.
 * Serving, the fingerprint and the admin's effective list all derive from
 * this one ordering.
 */
function servedProviders<T>(
  order: readonly string[],
  integrations: readonly Pick<LoadedIntegration, "id" | "providers">[],
  domain: string,
): ServedProvider<T>[] {
  const rank = rankOf(order);
  const entries = integrations.flatMap((integration) =>
    ((integration.providers.get(domain) ?? []) as T[]).map((provider, position) => {
      const id = member(provider, "id");
      return {
        integrationId: integration.id,
        provider,
        listed: rank.has(integration.id),
        key: typeof id === "string" ? id : position,
      };
    }),
  );
  const listed = entries
    .filter((entry) => entry.listed)
    .sort((a, b) => (rank.get(a.integrationId) ?? 0) - (rank.get(b.integrationId) ?? 0));
  const rest = entries.filter((entry) => !entry.listed);
  const fallback = Object.hasOwn(FALLBACK_BY_DOMAIN, domain)
    ? FALLBACK_BY_DOMAIN[domain as ProviderDomain]
    : undefined;
  if (fallback) rest.sort(fallback);
  return [...listed, ...rest];
}

/**
 * The providers of `domain` in the operator's order: those of listed
 * integrations first, in list order, then the others in the domain's fallback
 * order, or none of the others when `unlisted` is `"exclude"`. The registered
 * objects are returned as they are; they must not be copied, since their data
 * members live on their prototype.
 */
export function collectOrderedProviders<T>(
  ctx: Pick<IntegrationContext, "getProviderOrder" | "getIntegrationsByDomain">,
  domain: ProviderDomain,
  options: { unlisted?: "append" | "exclude" } = {},
): OrderedProvider<T>[] {
  return servedProviders<T>(
    ctx.getProviderOrder(domain),
    ctx.getIntegrationsByDomain(domain),
    domain,
  )
    .filter((entry) => entry.listed || options.unlisted !== "exclude")
    .map(({ integrationId, provider }) => ({ integrationId, provider }));
}

/**
 * Each integration with a provider of `domain`, once, at the place its first
 * provider is served, flagged by whether it is listed. Unlisted ones are
 * included even where the domain excludes them, so an admin can offer them.
 */
export function effectiveProviderOrder(
  order: readonly string[],
  integrations: readonly Pick<LoadedIntegration, "id" | "providers">[],
  domain: string,
): Array<{ integrationId: string; listed: boolean }> {
  const seen = new Set<string>();
  return servedProviders(order, integrations, domain).flatMap(({ integrationId, listed }) => {
    if (seen.has(integrationId)) return [];
    seen.add(integrationId);
    return [{ integrationId, listed }];
  });
}

/**
 * What a domain's provider-order fingerprint hashes: each provider that serves
 * it, in served order, as its integration id and its id (or registration
 * position). Unlisted providers count only where the domain appends them.
 */
export function providerOrderFingerprintInput(
  source: Pick<IntegrationContext, "getProviderOrder" | "getIntegrationsByDomain">,
  domain: string,
): string {
  const include = unlistedRuleOf(domain) === "append";
  return JSON.stringify(
    servedProviders(source.getProviderOrder(domain), source.getIntegrationsByDomain(domain), domain)
      .filter((entry) => entry.listed || include)
      .map((entry) => [entry.integrationId, entry.key]),
  );
}
