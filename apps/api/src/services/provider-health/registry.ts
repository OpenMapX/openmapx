import type { ProviderHealth } from "./index.js";

/**
 * Singleton holder for the host's persistent ProviderHealth tracker. Mirrors
 * the AttributionIndex pattern — initialised in `integration-host.ts` on boot,
 * read by routes and the integration context during request handling.
 */
let _instance: ProviderHealth | null = null;

export function setProviderHealth(instance: ProviderHealth | null): void {
  _instance = instance;
}

export function getProviderHealth(): ProviderHealth | null {
  return _instance;
}

export { ProviderHealth } from "./index.js";
