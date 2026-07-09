import type { RoadFlowSegment } from "./types.js";

interface RoadFlowFeature {
  type: "Feature";
  id: string;
  geometry: RoadFlowSegment["geometry"];
  properties: Record<string, unknown>;
}

export interface RoadFlowFeatureCollection {
  type: "FeatureCollection";
  features: RoadFlowFeature[];
}

/**
 * Serializes flow segments into the GeoJSON FeatureCollection the `/flow`
 * fallback route (and any non-tile consumer) uses. Unlike
 * `eventsToFeatureCollection`, optional fields are omitted rather than
 * nulled — the traffic-flow overlay's Martin vector tiles already treat a
 * missing MVT attribute as "absent", so this mirrors that rather than
 * inventing a `null` convention the tile path doesn't have.
 */
export function flowToFeatureCollection(segments: RoadFlowSegment[]): RoadFlowFeatureCollection {
  return {
    type: "FeatureCollection",
    features: segments.map((s) => ({
      type: "Feature" as const,
      id: s.id,
      geometry: s.geometry,
      properties: {
        id: s.id,
        los: s.los,
        confidence: s.confidence,
        direction: s.direction,
        ...(s.speedRatio !== undefined && { speedRatio: s.speedRatio }),
        ...(s.currentSpeedKph !== undefined && { currentSpeedKph: s.currentSpeedKph }),
        ...(s.freeFlowSpeedKph !== undefined && { freeFlowSpeedKph: s.freeFlowSpeedKph }),
        ...(s.roads !== undefined && { roads: s.roads }),
        ...(s.source !== undefined && { source: s.source }),
        ...(s.observedAt !== undefined && { observedAt: s.observedAt }),
      },
    })),
  };
}
