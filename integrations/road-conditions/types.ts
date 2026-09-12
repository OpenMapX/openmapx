export type { RouteFlowInput, RouteFlowResponse, RouteFlowSpan } from "@openmapx/core";
export type {
  RoadConditionAttribution,
  RoadConditionEvent,
  RoadConditionRoadRef,
  RoadConditionSeverity,
  RoadConditionsProvider,
  RoadConditionsQuery,
  RoadConditionType,
  RoadFlowQuery,
  RoadFlowSegment,
  RoadState,
} from "@openmapx/integration-framework";

/**
 * The host's message resolver, as the overlay and popup receive it. Declared
 * here rather than in `popup.tsx` so backend-facing builds can reference it
 * without pulling a JSX module into a non-JSX program.
 */
export type RoadConditionTranslate = (
  key: string,
  values?: Record<string, string | number>,
) => string;
