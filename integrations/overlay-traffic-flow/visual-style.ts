import type { ExpressionSpecification } from "maplibre-gl";

/** Confidence opacity values shared by the renderer and the legend. */
export const TRAFFIC_FLOW_CONFIDENCE_OPACITY = {
  measured: 0.95,
  estimated: 0.7,
  typical: 0.6,
  fallback: 0.6,
} as const;

export const TRAFFIC_FLOW_CONFIDENCE_STEPS = [
  { key: "measured", opacity: TRAFFIC_FLOW_CONFIDENCE_OPACITY.measured },
  { key: "estimated", opacity: TRAFFIC_FLOW_CONFIDENCE_OPACITY.estimated },
  { key: "typical", opacity: TRAFFIC_FLOW_CONFIDENCE_OPACITY.typical },
] as const;

export const TRAFFIC_FLOW_OPACITY_EXPRESSION: ExpressionSpecification = [
  "match",
  ["get", "confidence"],
  "measured",
  TRAFFIC_FLOW_CONFIDENCE_OPACITY.measured,
  "estimated",
  TRAFFIC_FLOW_CONFIDENCE_OPACITY.estimated,
  "typical",
  TRAFFIC_FLOW_CONFIDENCE_OPACITY.typical,
  TRAFFIC_FLOW_CONFIDENCE_OPACITY.fallback,
];

/**
 * Only segments that carry traffic data are drawn. The tiles hold every road
 * segment; one with no speed reading and no declared level of service has no
 * traffic data, and drawing it would paint unknown roads as free-flowing. A
 * declared level (a DATEX jam, a declared free flow) still counts as data.
 */
export const TRAFFIC_FLOW_WITH_DATA_FILTER: ExpressionSpecification = [
  "any",
  ["has", "speed_ratio"],
  ["all", ["has", "los"], ["!=", ["get", "los"], "unknown"]],
];
