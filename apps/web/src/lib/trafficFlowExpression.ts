import { FLOW_FALLBACK_COLOR, FLOW_LOS_COLORS, FLOW_RATIO_STOPS } from "@openmapx/core";
import type maplibregl from "maplibre-gl";

/**
 * The shared traffic ramp as a MapLibre paint expression. The property names
 * differ per source — the `segment_flow` tiles carry `speed_ratio`/`los`, the
 * route's band GeoJSON carries `speedRatio`/`los` — so the caller names them and
 * the ramp itself stays in one place.
 */
export function flowColorExpression(
  ratioProperty: string,
  losProperty: string,
): maplibregl.ExpressionSpecification {
  const losMatch: unknown[] = ["match", ["get", losProperty]];
  for (const [los, color] of Object.entries(FLOW_LOS_COLORS)) {
    if (los === "free_flow" || los === "unknown") continue;
    losMatch.push(los, color);
  }
  losMatch.push(FLOW_FALLBACK_COLOR);

  const interpolate: unknown[] = ["interpolate", ["linear"], ["get", ratioProperty]];
  for (const [stop, color] of FLOW_RATIO_STOPS) interpolate.push(stop, color);

  return [
    "case",
    ["==", ["get", ratioProperty], null],
    losMatch,
    interpolate,
  ] as unknown as maplibregl.ExpressionSpecification;
}
