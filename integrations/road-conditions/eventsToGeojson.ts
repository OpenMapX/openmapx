import type { RoadConditionEvent } from "./types.js";

interface RoadConditionFeature {
  type: "Feature";
  id: string;
  geometry: RoadConditionEvent["geometry"];
  properties: Omit<RoadConditionEvent, "geometry">;
}

export interface RoadConditionFeatureCollection {
  type: "FeatureCollection";
  features: RoadConditionFeature[];
}

/**
 * Serializes road-condition situations into the GeoJSON FeatureCollection the
 * overlay and the nav client consume. Every field but the geometry travels
 * verbatim in the feature's properties — effects, validity, evidence and all —
 * so the client's reader rebuilds the same situation the provider published.
 */
export function eventsToFeatureCollection(
  events: RoadConditionEvent[],
): RoadConditionFeatureCollection {
  return {
    type: "FeatureCollection",
    features: events.map(({ geometry, ...properties }) => ({
      type: "Feature" as const,
      id: properties.id,
      geometry,
      properties,
    })),
  };
}
