import { createManifestAttribution } from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";

/**
 * Shared manifest-driven attribution store for the transit-motis integration.
 * Populated once by `setup(ctx)` in index.ts from `ctx.manifest.dataSources`,
 * then read by both `cloud.ts` and `local.ts` via the `for*` helpers below.
 *
 * Manifest declares two sources:
 *   - `transitous` — used by the Transitous provider (cloud.ts) and as the
 *     wrapper when the data comes from Transitous via local fallback.
 *   - `motis` — software metadata for the self-hosted instance; it does not
 *     certify an unknown timetable, street graph or duration supplier.
 */
export const attribution = createManifestAttribution();

export function attributionTransitous(): Attribution[] {
  const attr = attribution.bySource("transitous");
  return attr ? [attr] : [];
}

export function attributionLocal(): Attribution[] {
  const attr = attribution.bySource("motis");
  return attr ? [attr] : [];
}
