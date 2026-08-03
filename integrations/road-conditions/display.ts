import type { RoadConditionEvent } from "@openmapx/core";
import { markerPoints, representativePoint } from "./markers";

export type DisplayCoordinate = [number, number];
type LineString = Extract<RoadConditionEvent["geometry"], { type: "LineString" }>;
type MultiLineString = Extract<RoadConditionEvent["geometry"], { type: "MultiLineString" }>;
type Position = number[];
type LineCoordinates = Position[];
type LineEvent = RoadConditionEvent & { geometry: LineString | MultiLineString };

/**
 * Presentation geometry for one visible road-condition situation.
 *
 * `events` deliberately remains the source records. A display group is a
 * rendering convenience, not a replacement event and not a deduplication
 * result, so callers can still resolve every source record from a click.
 */
export interface RoadConditionDisplayGroup {
  displayId: string;
  events: RoadConditionEvent[];
  lineGeometry?: LineString | MultiLineString;
  markerCoordinates: DisplayCoordinate[];
  representativeCoordinate: DisplayCoordinate;
}

/** A line feature used for rendering, with every display group it represents. */
export interface RoadConditionDisplayLine {
  geometry: LineString | MultiLineString;
  displayIds: string[];
}

interface GroupAccumulator {
  displayId: string;
  events: RoadConditionEvent[];
}

function displayIdFor(event: RoadConditionEvent): string {
  return event.groupId
    ? `group:${event.provider}:${event.source}:${event.groupId}`
    : `event:${event.id}`;
}

function asDisplayCoordinate(position: Position): DisplayCoordinate | null {
  return typeof position[0] === "number" && typeof position[1] === "number"
    ? [position[0], position[1]]
    : null;
}

function lineComponentKey(component: LineCoordinates): string {
  return JSON.stringify(component);
}

function markerCoordinatesFor(event: RoadConditionEvent): DisplayCoordinate[] {
  if (event.geometry.type === "MultiPoint") {
    return event.geometry.coordinates
      .map(asDisplayCoordinate)
      .filter((coordinate): coordinate is DisplayCoordinate => coordinate !== null);
  }

  return markerPoints(event.geometry)
    .map((coordinate) => asDisplayCoordinate(coordinate))
    .filter((coordinate): coordinate is DisplayCoordinate => coordinate !== null);
}

function deduplicateLineComponents(components: LineCoordinates[]): LineCoordinates[] {
  const seen = new Set<string>();
  return components.filter((component) => {
    const key = lineComponentKey(component);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function lineGeometryFor(events: RoadConditionEvent[]): LineString | MultiLineString | undefined {
  const lineEvents = events.filter(
    (event): event is LineEvent =>
      event.geometry.type === "LineString" || event.geometry.type === "MultiLineString",
  );
  if (lineEvents.length === 0) return undefined;

  // Preserve a source LineString exactly when it is the only line record in
  // the display group. A source MultiLineString may contain disjoint
  // affected-road members, so keep it multi-part while removing exact
  // duplicate members that would otherwise be drawn repeatedly.
  if (lineEvents.length === 1) {
    const geometry = lineEvents[0]?.geometry as LineString | MultiLineString;
    if (geometry.type === "LineString") return geometry;
    const coordinates = deduplicateLineComponents(geometry.coordinates);
    return coordinates.length === geometry.coordinates.length
      ? geometry
      : { type: "MultiLineString", coordinates };
  }

  const coordinates = lineEvents.flatMap((event) => {
    if (event.geometry.type === "LineString") return [event.geometry.coordinates];
    return event.geometry.coordinates;
  });
  return { type: "MultiLineString", coordinates: deduplicateLineComponents(coordinates) };
}

/**
 * Deduplicate exact rendered line components across display groups. Source
 * records stay in their original groups; `displayIds` lets one visual line
 * resolve every group when it is clicked.
 */
export function buildRoadConditionDisplayLines(
  groups: RoadConditionDisplayGroup[],
): RoadConditionDisplayLine[] {
  const components = new Map<string, { coordinates: LineCoordinates; displayIds: Set<string> }>();

  for (const group of groups) {
    if (!group.lineGeometry) continue;
    const groupComponents =
      group.lineGeometry.type === "LineString"
        ? [group.lineGeometry.coordinates]
        : group.lineGeometry.coordinates;
    for (const coordinates of groupComponents) {
      const key = lineComponentKey(coordinates);
      const existing = components.get(key);
      if (existing) {
        existing.displayIds.add(group.displayId);
      } else {
        components.set(key, {
          coordinates,
          displayIds: new Set([group.displayId]),
        });
      }
    }
  }

  const buckets = new Map<string, { coordinates: LineCoordinates[]; displayIds: string[] }>();
  for (const component of components.values()) {
    const displayIds = [...component.displayIds].sort();
    const bucketKey = JSON.stringify(displayIds);
    const bucket = buckets.get(bucketKey);
    if (bucket) {
      bucket.coordinates.push(component.coordinates);
    } else {
      buckets.set(bucketKey, { coordinates: [component.coordinates], displayIds });
    }
  }

  return [...buckets.values()].map(({ coordinates, displayIds }) => ({
    geometry:
      coordinates.length === 1 && coordinates[0]
        ? { type: "LineString", coordinates: coordinates[0] }
        : { type: "MultiLineString", coordinates },
    displayIds,
  }));
}

/**
 * Normalize provider display relationships into renderable groups.
 *
 * Only an explicit provider/source/groupId relationship joins records. Dates,
 * headlines, severity, road names, proximity, and geometry are intentionally
 * not relationship inference signals: records that look alike but lack a
 * groupId remain separate events.
 */
export function buildRoadConditionDisplayGroups(
  events: RoadConditionEvent[],
): RoadConditionDisplayGroup[] {
  const grouped = new Map<string, GroupAccumulator>();

  for (const event of events) {
    const displayId = displayIdFor(event);
    const existing = grouped.get(displayId);
    if (existing) {
      existing.events.push(event);
    } else {
      grouped.set(displayId, { displayId, events: [event] });
    }
  }

  const result: RoadConditionDisplayGroup[] = [];
  for (const group of grouped.values()) {
    const lineGeometry = lineGeometryFor(group.events);
    const markerCoordinates = lineGeometry
      ? (() => {
          const representative = representativePoint(lineGeometry);
          return representative ? [representative] : [];
        })()
      : group.events.flatMap(markerCoordinatesFor);
    const representativeCoordinate = markerCoordinates[0];

    // The API contract supplies a valid GeoJSON geometry. If a malformed or
    // empty geometry slips through, leave it out of the renderable result
    // rather than inventing a location at [0, 0]. Its source record is still
    // untouched in the fetched data and can be diagnosed upstream.
    if (!representativeCoordinate) continue;

    result.push({
      displayId: group.displayId,
      events: group.events,
      ...(lineGeometry ? { lineGeometry } : {}),
      markerCoordinates,
      representativeCoordinate,
    });
  }

  return result;
}
