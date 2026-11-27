import {
  createProviderRegistrationCheck,
  type IntegrationContext,
  type IntegrationManifest,
  PROVIDER_SHAPES,
  type ProviderDomain,
  type ProviderRegistrar,
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
  const check = createProviderRegistrationCheck({ integrationId, manifest });
  const registrars: Partial<Record<ProviderRegistrar, (provider: object) => void>> = {};
  for (const domain of Object.keys(PROVIDER_SHAPES) as ProviderDomain[]) {
    registrars[PROVIDER_SHAPES[domain].registrar] = (provider) => {
      check(domain, provider);
      const existing = providers.get(domain) ?? [];
      existing.push(bind(domain, provider));
      providers.set(domain, existing);
    };
  }
  return registrars as ProviderRegistrars;
}
