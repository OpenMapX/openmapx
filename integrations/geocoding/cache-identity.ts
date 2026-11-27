import { createHash } from "node:crypto";
import type { IntegrationContext } from "@openmapx/integration-framework";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

/**
 * Hash configuration; credentials may affect identity but never appear in keys.
 * The selected chain enters as the geocoding order fingerprint, which names the
 * served geocoders in order and is derived from ids alone, so it holds across
 * restarts and changes whenever the chain does, an environment override
 * included.
 */
export function geocodingCacheIdentity(ctx: IntegrationContext): string {
  const providers = ctx
    .getIntegrationsByDomain("geocoding")
    .map((integration) => ({
      id: integration.id,
      config: integration.config,
      services: integration.resolvedServices,
      version: integration.manifest?.version,
      sources: integration.manifest?.dataSources,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const services = ["geocoder", "nominatim", "overpass"].map((key) => [
    key,
    ctx.getRequiredService(key),
  ]);
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          chain: ctx.getProviderOrderFingerprint("geocoding"),
          config: ctx.config,
          providers,
          services,
        }),
      ),
    )
    .digest("hex");
}
