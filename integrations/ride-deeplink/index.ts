import type { IntegrationContext, RideProvider } from "@openmapx/integration-framework";
import { assertRideProviderContract } from "@openmapx/integration-framework";
import { DEEPLINK_PROVIDERS } from "./providers/index.js";
import type { DeepLinkConfig, DeepLinkProvider } from "./types.js";

function readConfig(config: Record<string, unknown>): DeepLinkConfig {
  return {
    uberClientId: typeof config.uberClientId === "string" ? config.uberClientId : undefined,
    lyftPartnerId: typeof config.lyftPartnerId === "string" ? config.lyftPartnerId : undefined,
  };
}

function toRideProvider(builder: DeepLinkProvider, config: DeepLinkConfig): RideProvider {
  return {
    id: builder.id,
    meta: {
      name: builder.name,
      homepage: builder.homepage,
      sourceId: builder.sourceId,
      brandColor: builder.brandColor,
    },
    capabilities: { deepLink: true, quote: false, booking: false, tracking: false },
    // Uber and Lyft both forbid presenting them in an aggregated view beside
    // competitors, and the remaining apps here expose no quote to compare, so
    // no builder in this integration is ever comparable.
    permitsComparison: false,
    attribution: [{ sourceId: builder.sourceId, name: builder.name, url: builder.homepage }],
    async getAvailability() {
      // A link-out cannot verify service at a coordinate, so it reports
      // availability as unchecked rather than asserting coverage it has not
      // confirmed.
      return {
        data: { available: true, coverageChecked: false, products: [] },
        attributions: [{ sourceId: builder.sourceId, name: builder.name, url: builder.homepage }],
        freshness: {
          fetchedAt: new Date().toISOString(),
          hasRealtimeData: false,
          isStale: false,
        },
      };
    },
    createHandoff(request) {
      return builder.build(request, config);
    },
  };
}

/**
 * Ride-hailing handoff integration. Builds pre-filled links to external
 * ride-hailing apps; fetches nothing and needs no credentials. The optional
 * affiliate ids are applied here on the server so they never reach the
 * browser.
 */
export function setup(ctx: IntegrationContext): void {
  const config = readConfig(ctx.config);
  const enabled = Array.isArray(ctx.config.enabledProviders)
    ? new Set(ctx.config.enabledProviders.filter((v): v is string => typeof v === "string"))
    : null;

  for (const builder of DEEPLINK_PROVIDERS) {
    if (enabled && !enabled.has(builder.id)) continue;
    const provider = toRideProvider(builder, config);
    assertRideProviderContract(provider);
    ctx.registerRideProvider(provider);
  }
}
