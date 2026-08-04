import type { RoadConditionEvent } from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";

/** Whether a condition has been announced but has not started yet. */
export function isFutureRoadCondition(
  condition: Pick<RoadConditionEvent, "isForecast" | "validFrom">,
): boolean {
  if (condition.isForecast === true) return true;
  if (typeof condition.validFrom !== "string") return false;
  const from = Date.parse(condition.validFrom);
  return !Number.isNaN(from) && from > Date.now();
}

/** Shared visual state: future markers are dimmed but remain fully discoverable. */
export const ROAD_CONDITION_MARKER_OPACITY: maplibregl.ExpressionSpecification = [
  "case",
  ["get", "future"],
  0.55,
  1,
];

export const ROAD_CONDITION_ACTIVE_LINE_OPACITY = 0.7;
export const ROAD_CONDITION_FUTURE_LINE_OPACITY = 0.45;
export const ROAD_CONDITION_ACTIVE_LINE_DASHARRAY = [1] as const;
export const ROAD_CONDITION_FUTURE_LINE_DASHARRAY = [2, 1.5] as const;

/** Shared visual state: current lines show the flow beneath them; future lines are lighter. */
export const ROAD_CONDITION_LINE_OPACITY: maplibregl.ExpressionSpecification = [
  "case",
  ["get", "future"],
  ROAD_CONDITION_FUTURE_LINE_OPACITY,
  ROAD_CONDITION_ACTIVE_LINE_OPACITY,
];

/** Dashed affected-road geometry signals work that has not started yet. */
export const ROAD_CONDITION_LINE_DASHARRAY: maplibregl.ExpressionSpecification = [
  "case",
  ["get", "future"],
  ["literal", ROAD_CONDITION_FUTURE_LINE_DASHARRAY],
  ["literal", ROAD_CONDITION_ACTIVE_LINE_DASHARRAY],
];
