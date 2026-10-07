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

export type RouteTrafficPresentation =
  | { kind: "unavailable"; deadline: null }
  | { kind: "clear"; deadline: number }
  | { kind: "delay"; seconds: number; band: DelayBand; deadline: number | null };

/** A zero recosting difference cannot establish fresh congestion coverage. */
export function routeTrafficPresentation(route: Route, now: number): RouteTrafficPresentation {
  const delay = routeTrafficDelay(route);
  const coverage = route.trafficCoverage;
  const evaluatedAt =
    typeof coverage?.evaluatedAt === "string" ? Date.parse(coverage.evaluatedAt) : NaN;
  const validUntil =
    typeof coverage?.validUntil === "string" ? Date.parse(coverage.validUntil) : NaN;
  const fresh =
    [now, evaluatedAt, validUntil].every(Number.isFinite) &&
    evaluatedAt <= now &&
    now < validUntil &&
    validUntil - evaluatedAt <= 120_000;
  // Supplied evidence must not keep an expired or malformed estimate alive.
  if (coverage !== undefined && !fresh) return { kind: "unavailable", deadline: null };
  // A positive estimate remains useful even without route-wide coverage.
  if (delay?.band)
    return {
      kind: "delay",
      seconds: delay.seconds,
      band: delay.band,
      deadline: fresh ? validUntil : null,
    };
  if (delay && coverage?.complete === true && fresh) return { kind: "clear", deadline: validUntil };
  return { kind: "unavailable", deadline: null };
}
