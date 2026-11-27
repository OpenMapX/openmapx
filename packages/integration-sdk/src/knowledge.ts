export type {
  KnowledgeContext,
  KnowledgeProvider,
  KnowledgeResult,
} from "@openmapx/core/domains/knowledge";
export type { PlaceFact } from "@openmapx/core/types/place";
export { despikeSeries, findTideExtrema } from "@openmapx/core/utils/tideExtrema";
export { withKnowledgeContributors } from "@openmapx/integration-framework/knowledge-contributors";
export type {
  TideCurvePoint,
  TideEvent,
  TideStationResponse,
  TidesResponse,
  WaterLevelObservation,
} from "@openmapx/integration-framework/tides-integration-factory";
export { createTidesIntegration } from "@openmapx/integration-framework/tides-integration-factory";
