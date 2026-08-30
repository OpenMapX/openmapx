import {
  type AirQualityProvider,
  assertAirQualityProviderContract,
  type IntegrationContext,
} from "@openmapx/integration-framework";

export interface DiscoveredAirQualityProvider {
  provider: AirQualityProvider;
  integrationId: string;
}

function providerLike(value: unknown): value is AirQualityProvider {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { capabilities?: { has?: unknown } }).capabilities?.has === "function"
  );
}

/** Discover and validate enabled registrations anew for every canonical request. */
export function discoverAirQualityProviders(
  ctx: IntegrationContext,
): DiscoveredAirQualityProvider[] {
  const found: DiscoveredAirQualityProvider[] = [];
  for (const integration of ctx.getIntegrationsByDomain("air-quality")) {
    if (!integration.enabled || !integration.manifest.domains.includes("air-quality")) continue;
    const sourceIds = new Set(
      (integration.manifest.dataSources ?? []).map(({ sourceId }) => sourceId),
    );
    for (const candidate of integration.providers.get("air-quality") ?? []) {
      if (!providerLike(candidate)) continue;
      try {
        assertAirQualityProviderContract(candidate, sourceIds);
        found.push({ provider: candidate, integrationId: integration.id });
      } catch (error) {
        ctx.log.warn(
          `Skipping invalid air-quality provider registration from ${integration.id}: ${error instanceof Error ? error.message : "unknown contract error"}`,
        );
      }
    }
  }
  found.sort(
    (left, right) =>
      left.provider.priority - right.provider.priority ||
      left.provider.id.localeCompare(right.provider.id) ||
      left.integrationId.localeCompare(right.integrationId),
  );
  const unique = new Map<string, DiscoveredAirQualityProvider>();
  for (const item of found) {
    if (unique.has(item.provider.id)) {
      ctx.log.warn(`Skipping duplicate air-quality provider id: ${item.provider.id}`);
      continue;
    }
    unique.set(item.provider.id, item);
  }
  return [...unique.values()];
}
