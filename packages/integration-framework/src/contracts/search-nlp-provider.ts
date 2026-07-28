import type { SearchIntent, SpatialConstraint, TimeConstraint } from "@openmapx/core";

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

export interface AiCloudProcessor {
  /** Stable machine id used to de-duplicate legal disclosures. */
  id: string;
  /** Human-readable processor/service name. */
  name: string;
  /** ISO 3166-1 alpha-2 code, or "VARIES" for a routing service. */
  countryCode: string;
  privacyUrl: string;
}

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
