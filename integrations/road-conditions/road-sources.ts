/**
 * Data sources about the road itself that this overlay can draw beside the
 * incidents, in the order the legend lists them. Each is its own data-source
 * integration; the overlay shows only those the server lists.
 */
export const ROAD_SOURCE_IDS = [
  "message-signs",
  "road-weather",
  "road-maintenance",
  "border-crossings",
] as const;

export type RoadSourceId = (typeof ROAD_SOURCE_IDS)[number];
