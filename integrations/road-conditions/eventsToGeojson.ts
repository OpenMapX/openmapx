import type { RoadConditionEvent } from "./types.js";

interface RoadConditionFeature {
  type: "Feature";
  id: string;
  geometry: RoadConditionEvent["geometry"];
  properties: Record<string, unknown>;
}

export interface RoadConditionFeatureCollection {
  type: "FeatureCollection";
  features: RoadConditionFeature[];
}

/**
 * Serializes road-condition events into the GeoJSON FeatureCollection the
 * declarative overlay (and the nav client) consume. Property names are the
 * overlay's styling/popup contract: `severity` (paint), `type`/`headline`/
 * `description` (popup).
 */
export function eventsToFeatureCollection(
  events: RoadConditionEvent[],
): RoadConditionFeatureCollection {
  return {
    type: "FeatureCollection",
    features: events.map((e) => ({
      type: "Feature" as const,
      id: e.id,
      geometry: e.geometry,
      properties: {
        id: e.id,
        source: e.source,
        provider: e.provider,
        type: e.type,
        severity: e.severity,
        headline: e.headline,
        description: e.description ?? null,
        roadState: e.roadState ?? null,
        roads: e.roads ?? null,
        validFrom: e.validFrom ?? null,
        validTo: e.validTo ?? null,
        schedule: e.schedule ?? null,
        dataUpdatedAt: e.dataUpdatedAt ?? null,
        attribution: e.attribution ?? null,
      },
    })),
  };
}
