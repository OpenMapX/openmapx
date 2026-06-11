import type { SearchIntent, SpatialConstraint, TimeConstraint } from "@openmapx/core";

export type { SearchIntent, SpatialConstraint, TimeConstraint };

export const NL_CONFIDENCE_FLOOR = 0.4;

export function isPlausibleNlSearch(intent: SearchIntent): boolean {
  return intent.confidence >= NL_CONFIDENCE_FLOOR && intent.categories.length > 0;
}

export type NlpProviderId = "local" | "claude" | "openai" | "keyword";

export interface ParseContext {
  mapCenter: [number, number];
  mapBbox: { south: number; west: number; north: number; east: number };
  lang?: string;
}

export interface NlpProvider {
  readonly id: NlpProviderId;
  readonly requiresNetwork: boolean;
  parseQuery(query: string, ctx: ParseContext): Promise<SearchIntent>;
}
