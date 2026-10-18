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

/** Hash configuration; credentials may affect identity but never appear in keys. */
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
    .update(JSON.stringify(canonical({ config: ctx.config, providers, services })))
    .digest("hex");
}
