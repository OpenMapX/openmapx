import type { RoadConditionEvent } from "@openmapx/core";
import { markerPoints, representativePoint } from "./markers";

export type DisplayCoordinate = [number, number];
type LineString = Extract<RoadConditionEvent["geometry"], { type: "LineString" }>;
type MultiLineString = Extract<RoadConditionEvent["geometry"], { type: "MultiLineString" }>;
type Position = number[];
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

function lineGeometryFor(events: RoadConditionEvent[]): LineString | MultiLineString | undefined {
  const lineEvents = events.filter(
    (event): event is LineEvent =>
      event.geometry.type === "LineString" || event.geometry.type === "MultiLineString",
  );
  if (lineEvents.length === 0) return undefined;

  // Preserve a source MultiLineString exactly when it is the only line record
  // in the display group. It may contain disjoint affected-road members that
  // must not be collapsed into a synthetic chord.
  if (lineEvents.length === 1) {
    return lineEvents[0]?.geometry as LineString | MultiLineString;
  }

  const coordinates = lineEvents.flatMap((event) => {
    if (event.geometry.type === "LineString") return [event.geometry.coordinates];
    return event.geometry.coordinates;
  });
  return { type: "MultiLineString", coordinates };
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
