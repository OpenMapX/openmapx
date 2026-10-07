import { bandForDelayRatio, type DelayBand, type Route } from "@openmapx/core";

/** Same-path estimate against the engine recosting that excludes current speeds. */
export function routeTrafficDelay(
  route: Route,
): { seconds: number; band: DelayBand | null } | null {
  const baseline = route.baselineDuration;
  if (
    (route.mode !== "driving" && route.mode !== "motorcycle") ||
    typeof baseline !== "number" ||
    !Number.isFinite(baseline) ||
    baseline <= 0 ||
    !Number.isFinite(route.duration) ||
    route.duration < 0
  )
    return null;
  const seconds = route.duration - baseline;
  return {
    seconds,
    band: seconds >= 300 ? bandForDelayRatio(seconds / baseline) : null,
  };
}
