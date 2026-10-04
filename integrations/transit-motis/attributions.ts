import { createManifestAttribution } from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { isTransitousUrl } from "@openmapx/mobility-core/motis-client";

/**
 * Shared manifest-driven attribution store for the transit-motis integration.
 * Populated once by `setup(ctx)` in index.ts from `ctx.manifest.dataSources`,
 * then read by both `cloud.ts` and `local.ts` via the `for*` helpers below.
 *
 * Manifest declares two sources:
 *   - `transitous` — used by the Transitous pass-through (cloud.ts) and as
 *     the wrapper when the data comes from Transitous via local fallback.
 *   - `motis` — used by the self-hosted MOTIS instance (local.ts) when the
 *     host hasn't indexed a more specific feed-tag attribution. A deployment
 *     without its own MOTIS points the local endpoint at Transitous; that
 *     endpoint is then credited as Transitous.
 */
export const attribution = createManifestAttribution();

let localServedByTransitous = false;

/** Record the local MOTIS endpoint so its credit names whoever serves it. */
export function setLocalEndpoint(url: string): void {
  localServedByTransitous = isTransitousUrl(url);
}

export function attributionTransitous(): Attribution[] {
  const attr = attribution.bySource("transitous");
  return attr ? [attr] : [];
}

export function attributionLocal(): Attribution[] {
  if (localServedByTransitous) return attributionTransitous();
  const attr = attribution.bySource("motis");
  return attr ? [attr] : [];
}
