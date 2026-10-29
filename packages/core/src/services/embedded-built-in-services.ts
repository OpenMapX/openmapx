import type { BuiltInManifestSource } from "./built-in-service-source";

/**
 * The release's built-in service manifests embedded in this process's runtime
 * bundle, or `null` when it runs from source (tsx, tests and the host CLI),
 * which reads the checkout it runs from instead.
 *
 * The ops-agent's runtime bundle replaces this module with
 * `embedded-built-in-services.bundle.ts` (scripts/build-runtime-bundles.mjs).
 * The choice is made when the bundle is built, so no setting can switch a
 * bundled agent back to the checkout.
 */
export function embeddedBuiltInServiceManifests(): BuiltInManifestSource | null {
  return null;
}

/** The built-in integration manifests embedded the same way, or `null` from source. */
export function embeddedBuiltInIntegrationManifests(): BuiltInManifestSource | null {
  return null;
}
