import type { StreetLevelCapabilities } from "@openmapx/core";
import type { StreetLevelProvider } from "@openmapx/integration-framework";
import type { FastifyInstance } from "fastify";
import { getAllIntegrations, getIntegrationProviders } from "../integration-host.js";
import { envString } from "../utils/env.js";

const DEFAULT_CHAIN = "panoramax";

/**
 * Order and filter provider capabilities by the configured chain. A provider
 * that is registered but absent from the chain stays disabled, which is how
 * Mapillary remains opt-in.
 */
export function orderProviders<T extends { id: string }>(
  capabilities: readonly T[],
  chain: string,
): T[] {
  const wanted = (chain || DEFAULT_CHAIN)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const byId = new Map(capabilities.map((capability) => [capability.id, capability]));
  const ordered: T[] = [];
  for (const id of wanted) {
    const capability = byId.get(id);
    if (capability) ordered.push(capability);
  }
  return ordered;
}

/**
 * Capabilities of every street-level-imagery provider registered by an integration.
 *
 * The privacy URL is taken from the owning integration's manifest rather than
 * hardcoded in the provider: the manifest already declares it for the legal
 * tables, and duplicating a third-party host inside integration source would
 * read as an undisclosed contacted host to `check-data-flows`.
 */
function collectCapabilities(): StreetLevelCapabilities[] {
  const result: StreetLevelCapabilities[] = [];
  for (const integration of getAllIntegrations()) {
    const providers = getIntegrationProviders<StreetLevelProvider>(
      integration.id,
      "street-level-imagery",
    );
    if (providers.length === 0) continue;

    const dataSources = integration.manifest.dataSources ?? [];
    for (const provider of providers) {
      const capabilities = provider.capabilities();
      // Prefer the dataSource describing this provider; fall back to the first
      // for single-source integrations. A provider that sets its own
      // privacyUrl (e.g. a per-instance one) keeps it.
      const declared =
        dataSources.find((source) => source.sourceId === provider.id) ?? dataSources[0];
      const privacyUrl = capabilities.privacyUrl ?? declared?.providerPrivacyUrl;
      result.push(privacyUrl ? { ...capabilities, privacyUrl } : capabilities);
    }
  }
  return result;
}

/**
 * Fastify plugin. Registered with `{ prefix: "/api" }` alongside its
 * neighbours, so the path here must NOT repeat `/api`.
 */
export async function streetLevelRoute(app: FastifyInstance): Promise<void> {
  app.get("/street-level-imagery/providers", async (_req, reply) => {
    const chain = envString("INTEGRATION_STREET_LEVEL_IMAGERY_PROVIDER", DEFAULT_CHAIN);
    return reply.send(orderProviders(collectCapabilities(), chain));
  });
}
