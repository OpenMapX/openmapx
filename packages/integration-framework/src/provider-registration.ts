import { ID_SCHEME_PATTERN } from "@openmapx/core/place-ids";
import {
  type AirQualityProvider,
  assertAirQualityProviderContract,
} from "./contracts/air-quality-provider";
import {
  assertRealtimeProviderContract,
  assertRideProviderContract,
  assertTransitProviderContract,
} from "./contracts/assert-contract";
import {
  assertLandmarkModelProviderContract,
  type LandmarkModelProvider,
} from "./contracts/landmark-model-provider";
import type { MobilityDataSourceProvider } from "./contracts/mobility-data-source-provider";
import {
  assertProviderShape,
  PROVIDER_SHAPES,
  type ProviderDomain,
} from "./contracts/provider-shapes";
import type { RealtimeProvider } from "./contracts/realtime-provider";
import type { RideProvider } from "./contracts/ride-provider";
import type { TransitProvider } from "./contracts/transit-provider";
import type { IntegrationManifest } from "./manifest";

/**
 * The checks every provider passes when an integration registers it: its
 * shape, its domain's contract, and one provider per key, domain and
 * integration. The host and the testing context share them, so a provider
 * an author's tests accept is one the host accepts. Returns the check for
 * one integration; it remembers the keys registered through it.
 */
export function createProviderRegistrationCheck(args: {
  integrationId: string;
  manifest: Pick<IntegrationManifest, "id" | "dataSources">;
}): (domain: ProviderDomain, provider: object) => void {
  const { integrationId, manifest } = args;
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
  return (domain, provider) => {
    assertProviderShape(domain, provider, integrationId);
    contracts[domain]?.(provider as never);
    const keyMember = PROVIDER_SHAPES[domain].key;
    if (!keyMember) return;
    const key = Reflect.get(provider, keyMember) as string;
    const keys = registeredKeys.get(domain) ?? new Set<string>();
    if (keys.has(key))
      throw new Error(
        `Integration ${integrationId}: ${domain} provider ${key} is registered twice`,
      );
    keys.add(key);
    registeredKeys.set(domain, keys);
  };
}
