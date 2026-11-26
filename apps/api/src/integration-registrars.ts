import { ID_SCHEME_PATTERN } from "@openmapx/core/place-ids";
import {
  type AirQualityProvider,
  assertAirQualityProviderContract,
  assertLandmarkModelProviderContract,
  assertProviderShape,
  assertRealtimeProviderContract,
  assertRideProviderContract,
  assertTransitProviderContract,
  type IntegrationContext,
  type IntegrationManifest,
  type LandmarkModelProvider,
  type MobilityDataSourceProvider,
  PROVIDER_SHAPES,
  type ProviderDomain,
  type ProviderRegistrar,
  type RealtimeProvider,
  type RideProvider,
  type TransitProvider,
} from "@openmapx/integration-framework";

export type ProviderRegistrars = Pick<IntegrationContext, ProviderRegistrar>;

/**
 * Builds the `register*` methods of one integration's context. Each checks the
 * provider's shape and its domain's contract before storing it, so a malformed
 * provider fails the integration's setup instead of a later request.
 */
export function createProviderRegistrars(args: {
  integrationId: string;
  manifest: IntegrationManifest;
  providers: Map<string, unknown[]>;
  bind: <T extends object>(domain: ProviderDomain, provider: T) => T;
}): ProviderRegistrars {
  const { integrationId, manifest, providers, bind } = args;
  const declaredSourceIds = () =>
    new Set(manifest.dataSources?.map(({ sourceId }) => sourceId) ?? []);
  const contracts: Partial<Record<ProviderDomain, (provider: never) => void>> = {
    transit: (provider: TransitProvider) => assertTransitProviderContract(provider),
    "live-transit": (provider: RealtimeProvider) => assertRealtimeProviderContract(provider),
    "ride-hailing": (provider: RideProvider) => assertRideProviderContract(provider),
    "air-quality": (provider: AirQualityProvider) =>
      assertAirQualityProviderContract(provider, declaredSourceIds()),
    "landmark-models": (provider: LandmarkModelProvider) =>
      assertLandmarkModelProviderContract(provider, manifest.id, declaredSourceIds()),
    "data-source": (provider: MobilityDataSourceProvider) => {
      // The id is the scheme of the place ids its items open as.
      if (!ID_SCHEME_PATTERN.test(provider.id))
        throw new Error(
          `Data source id "${provider.id}" must start with a letter and use only lower-case letters, digits and hyphens, because it names its places' id scheme`,
        );
    },
  };
  // Per integration only: two integrations may share a provider id, and the
  // orchestrators' own dedupe decides between them.
  const registeredKeys = new Map<ProviderDomain, Set<string>>();
  const registrars: Partial<Record<ProviderRegistrar, (provider: object) => void>> = {};
  for (const domain of Object.keys(PROVIDER_SHAPES) as ProviderDomain[]) {
    const { registrar, key: keyMember } = PROVIDER_SHAPES[domain];
    registrars[registrar] = (provider) => {
      assertProviderShape(domain, provider, integrationId);
      contracts[domain]?.(provider as never);
      if (keyMember) {
        const key = Reflect.get(provider, keyMember) as string;
        const keys = registeredKeys.get(domain) ?? new Set<string>();
        if (keys.has(key))
          throw new Error(
            `Integration ${integrationId}: ${domain} provider ${key} is registered twice`,
          );
        keys.add(key);
        registeredKeys.set(domain, keys);
      }
      const existing = providers.get(domain) ?? [];
      existing.push(bind(domain, provider));
      providers.set(domain, existing);
    };
  }
  return registrars as ProviderRegistrars;
}
