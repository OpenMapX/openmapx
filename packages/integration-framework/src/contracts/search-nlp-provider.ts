import type { SearchIntent, SpatialConstraint, TimeConstraint } from "@openmapx/core";
import type { AiCloudProcessor } from "@openmapx/core/api-contracts";

export type { SearchIntent, SpatialConstraint, TimeConstraint };

export const NL_CONFIDENCE_FLOOR = 0.4;

export function isPlausibleNlSearch(intent: SearchIntent): boolean {
  return intent.confidence >= NL_CONFIDENCE_FLOOR && intent.filter.selectors.length > 0;
}

/**
 * Stable operator-defined provider id. Provider ids are intentionally open:
 * search-NLP integrations may register multiple models/endpoints without
 * changing this framework contract.
 */
export type NlpProviderId = string;

export type { AiCloudProcessor } from "@openmapx/core/api-contracts";

export interface ParseContext {
  mapCenter: [number, number];
  mapBbox: { south: number; west: number; north: number; east: number };
  lang?: string;
}

export interface NlpProvider {
  readonly id: NlpProviderId;
  readonly label: string;
  /** Changes whenever the provider endpoint/model/output behavior changes. */
  readonly cacheKey: string;
  /** Keyword parsing is deterministic and is not presented as AI. */
  readonly isAi: boolean;
  readonly requiresNetwork: boolean;
  /** Empty for local providers. Never contains secrets. */
  readonly cloudProcessors: AiCloudProcessor[];
  parseQuery(query: string, ctx: ParseContext): Promise<SearchIntent>;
}
