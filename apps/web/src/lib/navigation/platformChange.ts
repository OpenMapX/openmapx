import type { TransitPlace } from "@openmapx/mobility-core/transit";

/**
 * The scheduled platform, but only when a realtime update has moved boarding to
 * a different track — i.e. both are known and they differ. Returns undefined
 * otherwise (no change, or one side unknown), which reads as "no platform
 * change to flag".
 */
export function changedFromPlatform(
  place: Pick<TransitPlace, "platformCode" | "scheduledPlatformCode">,
): string | undefined {
  const { platformCode, scheduledPlatformCode } = place;
  if (platformCode && scheduledPlatformCode && platformCode !== scheduledPlatformCode) {
    return scheduledPlatformCode;
  }
  return undefined;
}
