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
