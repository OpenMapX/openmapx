import type { StreetLevelCapabilities } from "@openmapx/core";
import { envString } from "@openmapx/core/server-env";
import type { StreetLevelProvider } from "@openmapx/integration-framework";
import type { FastifyInstance } from "fastify";
import { getAllIntegrations, getIntegrationProviders } from "../integration-host.js";
import { declareRouteAuth } from "../utils/route-auth.js";

/**
 * Order and filter provider capabilities by the configured chain.
 *
 * An empty chain means "every provider that registered", in registration
 * order. The opt-in gate is the integration's own `enabled` flag — the one an
 * operator actually sees and toggles in the admin panel. Defaulting this to a
 * single hardcoded provider instead would add a second, invisible gate that
 * silently swallows a provider the operator had just enabled.
 *
 * Setting the chain explicitly still pins both the set and its priority.
 */
export function orderProviders<T extends { id: string }>(
  capabilities: readonly T[],
  chain: string,
): T[] {
  const wanted = chain
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (wanted.length === 0) return [...capabilities];

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
  declareRouteAuth(app, "public");

  app.get("/street-level-imagery/providers", async (_req, reply) => {
    const chain = envString("INTEGRATION_STREET_LEVEL_IMAGERY_PROVIDER", "");
    return reply.send(orderProviders(collectCapabilities(), chain));
  });
}
