import { describe, expect, it } from "vitest";
import type { LngLat } from "../../types/geometry";
import type { RoadConditionEvent, RoadConditionSeverity } from "../../types/roadConditions";
import type { RouteStep } from "../../types/routing";
import { haversineDistance } from "../../utils/coordinates";
import { angularDifference, bearingBetween, routeBearingAt } from "../bearing";
import {
  type IncidentAlert,
  type ProjectEventsOptions,
  projectEventsToRoute,
} from "../incidentProjection";
import {
  readRouteMatcherCounters,
  resetRouteMatcherCounters,
  setRouteMatcherCounting,
} from "../routeMatcher";
import { snapToRoute } from "../snap";

// A straight ~6.85 km west→east route at latitude 52.
const route: LngLat[] = [
  [13.0, 52.0],
  [13.1, 52.0],
];

function ev(
  id: string,
  severity: RoadConditionSeverity,
  geometry: RoadConditionEvent["geometry"],
  type: RoadConditionEvent["type"] = "accident",
  extra: Partial<RoadConditionEvent> = {},
): RoadConditionEvent {
  return {
    id,
    source: "s",
    provider: "p",
    type,
    severity,
    geometry,
    headline: `${type} ${id}`,
    ...extra,
  };
}

const motorwayStep = {
  instruction: "Continue on A 57",
  distance: 6800,
  duration: 300,
  coordinates: route,
  roadNames: ["A 57/E 31"],
};

describe("projectEventsToRoute", () => {
  it("projects an on-corridor incident ahead with a severity-scaled approach window", () => {
    const out = projectEventsToRoute(
      [ev("a", "high", { type: "Point", coordinates: [13.05, 52.00008] })], // ~9 m off
      route,
      0,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe("traffic_incident");
    expect(out[0]?.eventType).toBe("accident");
    expect(out[0]?.severity).toBe("high");
    expect(out[0]?.approach).toEqual({ leadSec: 20, minM: 400, maxM: 1500 });
    expect(out[0]?.alongMeters).toBeGreaterThan(3000);
    expect(out[0]?.alongMeters).toBeLessThan(3900);
  });

  it("carries the event's delaySeconds onto the projected alert", () => {
    const out = projectEventsToRoute(
      [
        ev("d", "high", { type: "Point", coordinates: [13.05, 52.00008] }, "accident", {
          delaySeconds: 900,
        }),
      ],
      route,
      0,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.delaySeconds).toBe(900);
  });

  it("carries the display group id without changing route projection", () => {
    const out = projectEventsToRoute(
      [
        ev("grouped", "high", { type: "Point", coordinates: [13.05, 52.00008] }, "roadworks", {
          groupId: "works-42",
        }),
      ],
      route,
      0,
    );

    expect(out).toHaveLength(1);
    expect(out[0]?.groupId).toBe("works-42");
  });

  it("drops incidents off the corridor", () => {
    const out = projectEventsToRoute(
      [ev("b", "high", { type: "Point", coordinates: [13.05, 52.02] })], // ~2.2 km off
      route,
      0,
    );
    expect(out).toEqual([]);
  });

  it("drops incidents behind the current position", () => {
    const out = projectEventsToRoute(
      [ev("c", "high", { type: "Point", coordinates: [13.02, 52.0] })], // ~1.4 km along
      route,
      5000,
    );
    expect(out).toEqual([]);
  });

  it("uses the first sustained route-overlapping portion of a line geometry", () => {
    const out = projectEventsToRoute(
      [
        ev("d", "medium", {
          type: "LineString",
          coordinates: [
            [13.04, 52.00005],
            [13.06, 52.00005],
          ],
        }),
      ],
      route,
      0,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.coord[0]).toBeGreaterThan(13.039);
    expect(out[0]?.coord[0]).toBeLessThan(13.061);
  });

  it("sorts by along-distance and scales the approach window by severity", () => {
    const out = projectEventsToRoute(
      [
        ev("far", "low", { type: "Point", coordinates: [13.08, 52.0] }),
        ev("near", "critical", { type: "Point", coordinates: [13.02, 52.0] }),
      ],
      route,
      0,
    );
    expect(out.map((a) => a.id)).toEqual(["near", "far"]);
    expect(out[0]?.approach).toEqual({ leadSec: 30, minM: 600, maxM: 2500 });
  });

  it("drops an exit whose geometry only touches the route at the split", () => {
    const out = projectEventsToRoute(
      [
        ev(
          "exit",
          "critical",
          {
            type: "LineString",
            coordinates: [
              [13.05, 52.0],
              [13.0502, 52.0001],
              [13.052, 52.003],
              [13.055, 52.006],
            ],
          },
          "road_closure",
        ),
      ],
      route,
      0,
    );
    expect(out).toEqual([]);
  });

  it("drops a nearby parallel road when its road identity differs", () => {
    const out = projectEventsToRoute(
      [
        ev(
          "parallel",
          "high",
          {
            type: "LineString",
            coordinates: [
              [13.03, 52.00015],
              [13.07, 52.00015],
            ],
          },
          "congestion",
          { roads: [{ name: "L 9", direction: "east" }] },
        ),
      ],
      route,
      0,
      { corridorMeters: 50, routeSteps: [motorwayStep] },
    );
    expect(out).toEqual([]);
  });

  it("drops the opposite carriageway and keeps the route direction", () => {
    const westbound = ev(
      "westbound",
      "high",
      {
        type: "LineString",
        coordinates: [
          [13.07, 52.00005],
          [13.03, 52.00005],
        ],
      },
      "congestion",
      { roads: [{ name: "A57", direction: "west" }] },
    );
    const eastbound = ev(
      "eastbound",
      "high",
      {
        type: "LineString",
        coordinates: [
          [13.03, 52.00005],
          [13.07, 52.00005],
        ],
      },
      "congestion",
      { roads: [{ name: "A 57", direction: "east" }] },
    );
    const out = projectEventsToRoute([westbound, eastbound], route, 0, {
      routeSteps: [motorwayStep],
    });
    expect(out.map((incident) => incident.id)).toEqual(["eastbound"]);
  });

  it("uses supplied direction to reject a point on the opposite carriageway", () => {
    const out = projectEventsToRoute(
      [
        ev(
          "opposite-point",
          "medium",
          { type: "Point", coordinates: [13.05, 52.0] },
          "congestion",
          {
            roads: [{ name: "A 57", direction: "west" }],
          },
        ),
      ],
      route,
      0,
      { routeSteps: [motorwayStep] },
    );
    expect(out).toEqual([]);
  });
});

/**
 * The pre-refactor implementation, preserved verbatim (module-private helpers
 * renamed `legacy*` to avoid colliding with the production names) as an oracle
 * for the differential suite below. It scans the whole route with
 * `snapToRoute` on every candidate coordinate instead of a prepared matcher —
 * exactly the behaviour {@link projectEventsToRoute} must still reproduce bit
 * for bit after switching to `routeMatcher.ts`.
 */
const LEGACY_SEVERITY_APPROACH: Record<
  RoadConditionSeverity,
  { leadSec: number; minM: number; maxM: number }
> = {
  critical: { leadSec: 30, minM: 600, maxM: 2500 },
  high: { leadSec: 20, minM: 400, maxM: 1500 },
  medium: { leadSec: 14, minM: 250, maxM: 1000 },
  low: { leadSec: 10, minM: 150, maxM: 600 },
  unknown: { leadSec: 12, minM: 200, maxM: 800 },
};

const LEGACY_DEFAULT_CORRIDOR_M = 20;
const LEGACY_DEFAULT_LOOKAHEAD_M = 25_000;
const LEGACY_DEFAULT_MIN_LINE_OVERLAP_M = 75;
const LEGACY_MIN_SHORT_LINE_OVERLAP_M = 8;
const LEGACY_LINE_OVERLAP_FRACTION = 0.25;
const LEGACY_MAX_SEGMENT_SAMPLES = 64;
const LEGACY_TARGET_SAMPLE_LENGTH_M = 30;
const LEGACY_DEFAULT_DIRECTION_TOLERANCE_DEG = 60;

interface LegacyRouteCandidate {
  coord: LngLat;
  alongMeters: number;
  routeBearing: number;
}

function legacyFlattenPositions(geometry: RoadConditionEvent["geometry"]): LngLat[] {
  const out: LngLat[] = [];
  const walk = (coordinates: unknown): void => {
    if (!Array.isArray(coordinates)) return;
    if (typeof coordinates[0] === "number" && typeof coordinates[1] === "number") {
      out.push([coordinates[0], coordinates[1]]);
      return;
    }
    for (const child of coordinates) walk(child);
  };
  if (geometry.type === "GeometryCollection") {
    for (const child of geometry.geometries) {
      for (const position of legacyFlattenPositions(child)) out.push(position);
    }
  } else {
    walk(geometry.coordinates);
  }
  return out;
}

function legacyLineStrings(geometry: RoadConditionEvent["geometry"]): LngLat[][] {
  if (geometry.type === "LineString") return [geometry.coordinates as LngLat[]];
  if (geometry.type === "MultiLineString") return geometry.coordinates as LngLat[][];
  if (geometry.type === "GeometryCollection") return geometry.geometries.flatMap(legacyLineStrings);
  return [];
}

function legacyNormalizeRoadName(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function legacyRoadNameKeys(name: string): string[] {
  return [name, ...name.split(/[/,;|]/)]
    .map(legacyNormalizeRoadName)
    .filter((key, index, keys) => key.length > 0 && keys.indexOf(key) === index);
}

function legacyEventRoadNames(event: RoadConditionEvent): Set<string> {
  return new Set((event.roads ?? []).flatMap((road) => legacyRoadNameKeys(road.name)));
}

function legacyRouteRoadNamesAt(steps: RouteStep[] | undefined, coord: LngLat): Set<string> {
  if (!steps?.length) return new Set();
  const candidates: Array<{ deviation: number; names: string[] }> = [];
  for (const step of steps) {
    if (!step.roadNames?.length || step.coordinates.length < 2) continue;
    const deviation = snapToRoute(step.coordinates, coord).deviationMeters;
    candidates.push({ deviation, names: step.roadNames });
  }
  if (candidates.length === 0) return new Set();
  const closest = Math.min(...candidates.map((candidate) => candidate.deviation));
  return new Set(
    candidates
      .filter((candidate) => candidate.deviation <= closest + 5)
      .flatMap((candidate) => candidate.names)
      .flatMap(legacyRoadNameKeys),
  );
}

function legacyRoadMatches(
  eventNames: Set<string>,
  routeSteps: RouteStep[] | undefined,
  coord: LngLat,
): boolean {
  if (eventNames.size === 0) return true;
  const routeNames = legacyRouteRoadNamesAt(routeSteps, coord);
  if (routeNames.size === 0) return true;
  return [...eventNames].some((name) => routeNames.has(name));
}

interface LegacyEventDirection {
  hasDirection: boolean;
  bidirectional: boolean;
  bearings: number[];
}

function legacyCardinalBearing(direction: string): number | null {
  const value = direction.trim().toLowerCase();
  if (/^(n|north|northbound|nord|nordwaerts|nordwärts)$/.test(value)) return 0;
  if (/^(e|east|eastbound|ost|ostwaerts|ostwärts)$/.test(value)) return 90;
  if (/^(s|south|southbound|sued|süd|suedwaerts|südwärts)$/.test(value)) return 180;
  if (/^(w|west|westbound|westwaerts|westwärts)$/.test(value)) return 270;
  return null;
}

function legacyEventDirection(event: RoadConditionEvent): LegacyEventDirection {
  const raw = (event.roads ?? [])
    .map((road) => road.direction?.trim())
    .filter((direction): direction is string => Boolean(direction));
  if (raw.length === 0) return { hasDirection: false, bidirectional: false, bearings: [] };
  if (
    raw.some((direction) => /^(both|all|both directions|beide|beide richtungen)$/i.test(direction))
  ) {
    return { hasDirection: true, bidirectional: true, bearings: [] };
  }
  const bearings = raw
    .map(legacyCardinalBearing)
    .filter((bearing): bearing is number => bearing !== null);
  const bidirectional = bearings.some((a) => bearings.some((b) => angularDifference(a, b) >= 120));
  return { hasDirection: true, bidirectional, bearings };
}

function legacyDirectionMatches(
  direction: LegacyEventDirection,
  routeBearing: number,
  fallbackLineBearing: number | null,
  tolerance: number,
): boolean {
  if (!direction.hasDirection || direction.bidirectional) return true;
  if (direction.bearings.length > 0) {
    return direction.bearings.some(
      (incidentBearing) => angularDifference(incidentBearing, routeBearing) <= tolerance,
    );
  }
  return (
    fallbackLineBearing === null ||
    angularDifference(fallbackLineBearing, routeBearing) <= tolerance
  );
}

function legacyPointCandidate(
  event: RoadConditionEvent,
  route: LngLat[],
  currentAlongMeters: number,
  corridor: number,
  lookahead: number,
  routeSteps: RouteStep[] | undefined,
  tolerance: number,
): LegacyRouteCandidate | null {
  const names = legacyEventRoadNames(event);
  const direction = legacyEventDirection(event);
  let best: LegacyRouteCandidate | null = null;
  for (const coord of legacyFlattenPositions(event.geometry)) {
    const snap = snapToRoute(route, coord);
    if (snap.deviationMeters > corridor) continue;
    const ahead = snap.alongMeters - currentAlongMeters;
    if (ahead <= 0 || ahead > lookahead) continue;
    if (!legacyRoadMatches(names, routeSteps, snap.snapped)) continue;
    const routeBearing = routeBearingAt(route, snap.segmentIndex);
    if (!legacyDirectionMatches(direction, routeBearing, null, tolerance)) continue;
    if (!best || snap.alongMeters < best.alongMeters) {
      best = { coord, alongMeters: snap.alongMeters, routeBearing };
    }
  }
  return best;
}

function legacyLineCandidate(
  event: RoadConditionEvent,
  lines: LngLat[][],
  route: LngLat[],
  currentAlongMeters: number,
  corridor: number,
  lookahead: number,
  routeSteps: RouteStep[] | undefined,
  minLineOverlap: number,
  tolerance: number,
): LegacyRouteCandidate | null {
  const names = legacyEventRoadNames(event);
  const direction = legacyEventDirection(event);
  let totalLength = 0;
  let matchedLength = 0;
  let best: LegacyRouteCandidate | null = null;

  for (const line of lines) {
    for (let index = 0; index < line.length - 1; index++) {
      const start = line[index];
      const end = line[index + 1];
      if (!start || !end) continue;
      const segmentLength = haversineDistance(start, end);
      if (segmentLength <= 0) continue;
      totalLength += segmentLength;
      const samples = Math.min(
        LEGACY_MAX_SEGMENT_SAMPLES,
        Math.max(1, Math.ceil(segmentLength / LEGACY_TARGET_SAMPLE_LENGTH_M)),
      );
      const sampleLength = segmentLength / samples;
      const lineBearing = bearingBetween(start, end);
      for (let sample = 0; sample < samples; sample++) {
        const ratio = (sample + 0.5) / samples;
        const coord: LngLat = [
          start[0] + (end[0] - start[0]) * ratio,
          start[1] + (end[1] - start[1]) * ratio,
        ];
        const snap = snapToRoute(route, coord);
        if (snap.deviationMeters > corridor) continue;
        const routeBearing = routeBearingAt(route, snap.segmentIndex);
        if (!legacyDirectionMatches(direction, routeBearing, lineBearing, tolerance)) continue;
        matchedLength += sampleLength;
        const ahead = snap.alongMeters - currentAlongMeters;
        if (ahead <= 0 || ahead > lookahead) continue;
        if (!best || snap.alongMeters < best.alongMeters) {
          best = { coord, alongMeters: snap.alongMeters, routeBearing };
        }
      }
    }
  }

  const requiredOverlap = Math.min(
    minLineOverlap,
    Math.max(LEGACY_MIN_SHORT_LINE_OVERLAP_M, totalLength * LEGACY_LINE_OVERLAP_FRACTION),
  );
  return best &&
    matchedLength >= requiredOverlap &&
    legacyRoadMatches(names, routeSteps, best.coord)
    ? best
    : null;
}

/** The oracle: byte-for-byte the pre-refactor `projectEventsToRoute`. */
function legacyProjectEventsToRoute(
  events: RoadConditionEvent[],
  routeGeometry: LngLat[],
  currentAlongMeters: number,
  opts: ProjectEventsOptions = {},
): IncidentAlert[] {
  if (routeGeometry.length < 2) return [];
  const corridor = opts.corridorMeters ?? LEGACY_DEFAULT_CORRIDOR_M;
  const lookahead = opts.lookaheadMeters ?? LEGACY_DEFAULT_LOOKAHEAD_M;
  const minLineOverlap = opts.minLineOverlapMeters ?? LEGACY_DEFAULT_MIN_LINE_OVERLAP_M;
  const tolerance = opts.directionToleranceDegrees ?? LEGACY_DEFAULT_DIRECTION_TOLERANCE_DEG;

  const out: IncidentAlert[] = [];
  for (const event of events) {
    const lines = legacyLineStrings(event.geometry);
    const candidate =
      lines.length > 0
        ? legacyLineCandidate(
            event,
            lines,
            routeGeometry,
            currentAlongMeters,
            corridor,
            lookahead,
            opts.routeSteps,
            minLineOverlap,
            tolerance,
          )
        : legacyPointCandidate(
            event,
            routeGeometry,
            currentAlongMeters,
            corridor,
            lookahead,
            opts.routeSteps,
            tolerance,
          );
    if (!candidate) continue;
    out.push({
      id: event.id,
      type: "traffic_incident",
      coord: candidate.coord,
      alongMeters: candidate.alongMeters,
      eventType: event.type,
      severity: event.severity,
      headline: event.headline,
      ...(event.groupId ? { groupId: event.groupId } : {}),
      ...(typeof event.delaySeconds === "number" ? { delaySeconds: event.delaySeconds } : {}),
      geometry: event.geometry,
      approach: LEGACY_SEVERITY_APPROACH[event.severity] ?? LEGACY_SEVERITY_APPROACH.unknown,
    });
  }
  out.sort((a, b) => a.alongMeters - b.alongMeters);
  return out;
}

/** Deterministic PRNG, so every randomized case below is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Metre offset from a base point, latitude-aware for the east component. */
function offsetLngLat(base: LngLat, eastMeters: number, northMeters: number): LngLat {
  const latRad = (base[1] * Math.PI) / 180;
  const dLon = eastMeters / (111_320 * Math.cos(latRad));
  const dLat = northMeters / 110_540;
  return [base[0] + dLon, base[1] + dLat];
}

const SEVERITIES: RoadConditionSeverity[] = ["critical", "high", "medium", "low", "unknown"];
const EVENT_TYPES: RoadConditionEvent["type"][] = [
  "accident",
  "roadworks",
  "congestion",
  "road_closure",
  "other",
];
const DIRECTIONS = ["north", "east", "south", "west", "both"];
const ROAD_NAMES = ["A 57/E 31", "A57", "B 9", "L 12"];

/** A gently curving route of `points` vertices spanning about `meters`, east from `base`. */
function randomRoute(rand: () => number, base: LngLat, meters: number, points: number): LngLat[] {
  const out: LngLat[] = [];
  for (let i = 0; i < points; i++) {
    const east = (meters * i) / (points - 1);
    const north = (rand() - 0.5) * 30; // gentle lateral wander, well inside a wide corridor
    out.push(offsetLngLat(base, east, north));
  }
  return out;
}

/** Named steps chunking `route`, each step covering a contiguous slice. */
function randomSteps(rand: () => number, route: LngLat[]): RouteStep[] {
  const stepCount = 1 + Math.floor(rand() * 3);
  const boundaries = [0];
  for (let i = 1; i < stepCount; i++) {
    boundaries.push(Math.floor((route.length * i) / stepCount));
  }
  boundaries.push(route.length);
  const steps: RouteStep[] = [];
  for (let i = 0; i < stepCount; i++) {
    const from = boundaries[i];
    const to = Math.max(from + 2, boundaries[i + 1]);
    const coordinates = route.slice(from, Math.min(to, route.length));
    if (coordinates.length < 2) continue;
    steps.push({
      instruction: `step ${i}`,
      distance: 0,
      duration: 0,
      coordinates,
      roadNames: rand() < 0.85 ? [ROAD_NAMES[Math.floor(rand() * ROAD_NAMES.length)]] : undefined,
    });
  }
  return steps;
}

/** One random road-condition event, sometimes on the route and sometimes not. */
function randomEvent(
  rand: () => number,
  base: LngLat,
  id: string,
  routeMeters: number,
): RoadConditionEvent {
  const isLine = rand() < 0.5;
  // Spread events across, before, and well beyond the route's own length so
  // both "off-route" and "beyond lookahead" cases show up on their own.
  const along = (rand() - 0.2) * routeMeters * 1.3;
  const lateral = rand() < 0.5 ? (rand() - 0.5) * 30 : (rand() - 0.5) * 200;
  const hasRoads = rand() < 0.6;
  const roads = hasRoads
    ? [
        {
          name: ROAD_NAMES[Math.floor(rand() * ROAD_NAMES.length)],
          direction: rand() < 0.7 ? DIRECTIONS[Math.floor(rand() * DIRECTIONS.length)] : undefined,
        },
      ]
    : undefined;
  const geometry: RoadConditionEvent["geometry"] = isLine
    ? {
        type: "LineString",
        coordinates: [
          offsetLngLat(base, along, lateral),
          offsetLngLat(base, along + 40 + rand() * 300, lateral + (rand() - 0.5) * 10),
        ],
      }
    : { type: "Point", coordinates: offsetLngLat(base, along, lateral) };
  return {
    id,
    source: "s",
    provider: "p",
    type: EVENT_TYPES[Math.floor(rand() * EVENT_TYPES.length)],
    severity: SEVERITIES[Math.floor(rand() * SEVERITIES.length)],
    geometry,
    headline: `random ${id}`,
    ...(roads ? { roads } : {}),
    ...(rand() < 0.3 ? { groupId: `group-${Math.floor(rand() * 3)}` } : {}),
    ...(rand() < 0.3 ? { delaySeconds: Math.floor(rand() * 1200) } : {}),
  };
}

describe("projectEventsToRoute matches the pre-refactor implementation exactly", () => {
  it("matches on the module's own fixtures (point, line, multi-step, opposite carriageway)", () => {
    const cases: Array<[RoadConditionEvent[], LngLat[], number, ProjectEventsOptions?]> = [
      [[ev("a", "high", { type: "Point", coordinates: [13.05, 52.00008] })], route, 0, undefined],
      [[ev("b", "high", { type: "Point", coordinates: [13.05, 52.02] })], route, 0, undefined],
      [[ev("c", "high", { type: "Point", coordinates: [13.02, 52.0] })], route, 5000, undefined],
      [
        [
          ev("d", "medium", {
            type: "LineString",
            coordinates: [
              [13.04, 52.00005],
              [13.06, 52.00005],
            ],
          }),
        ],
        route,
        0,
        undefined,
      ],
      [
        [
          ev("far", "low", { type: "Point", coordinates: [13.08, 52.0] }),
          ev("near", "critical", { type: "Point", coordinates: [13.02, 52.0] }),
        ],
        route,
        0,
        undefined,
      ],
      [
        [
          ev(
            "exit",
            "critical",
            {
              type: "LineString",
              coordinates: [
                [13.05, 52.0],
                [13.0502, 52.0001],
                [13.052, 52.003],
                [13.055, 52.006],
              ],
            },
            "road_closure",
          ),
        ],
        route,
        0,
        undefined,
      ],
      [
        [
          ev(
            "parallel",
            "high",
            {
              type: "LineString",
              coordinates: [
                [13.03, 52.00015],
                [13.07, 52.00015],
              ],
            },
            "congestion",
            { roads: [{ name: "L 9", direction: "east" }] },
          ),
        ],
        route,
        0,
        { corridorMeters: 50, routeSteps: [motorwayStep] },
      ],
      [
        [
          ev(
            "westbound",
            "high",
            {
              type: "LineString",
              coordinates: [
                [13.07, 52.00005],
                [13.03, 52.00005],
              ],
            },
            "congestion",
            { roads: [{ name: "A57", direction: "west" }] },
          ),
          ev(
            "eastbound",
            "high",
            {
              type: "LineString",
              coordinates: [
                [13.03, 52.00005],
                [13.07, 52.00005],
              ],
            },
            "congestion",
            { roads: [{ name: "A 57", direction: "east" }] },
          ),
        ],
        route,
        0,
        { routeSteps: [motorwayStep] },
      ],
    ];
    for (const [events, geometry, along, opts] of cases) {
      expect(projectEventsToRoute(events, geometry, along, opts)).toEqual(
        legacyProjectEventsToRoute(events, geometry, along, opts),
      );
    }
  });

  it("matches on duplicate/degenerate geometry: zero-length line segments and repeated points", () => {
    const degenerateLine = ev("dup-line", "medium", {
      type: "LineString",
      coordinates: [
        [13.04, 52.00005],
        [13.04, 52.00005],
        [13.045, 52.00005],
        [13.045, 52.00005],
        [13.06, 52.00005],
      ],
    });
    const degenerateGeometryCollection = ev(
      "dup-gc",
      "high",
      {
        type: "GeometryCollection",
        geometries: [
          { type: "Point", coordinates: [13.05, 52.00008] },
          { type: "Point", coordinates: [13.05, 52.00008] },
          {
            type: "LineString",
            coordinates: [
              [13.045, 52.00005],
              [13.045, 52.00005],
            ],
          },
        ],
      },
      "accident",
    );
    const events = [degenerateLine, degenerateGeometryCollection];
    expect(projectEventsToRoute(events, route, 0)).toEqual(
      legacyProjectEventsToRoute(events, route, 0),
    );
  });

  it("matches across randomized routes, multi-step road names, and mixed on/off-route events", () => {
    for (let seed = 0; seed < 60; seed++) {
      const rand = mulberry32(0x9e3779 + seed * 101);
      const base: LngLat = [11 + rand() * 4, 48 + rand() * 6];
      const routeMeters = 500 + rand() * 8000;
      const points = 3 + Math.floor(rand() * 10);
      const randRoute = randomRoute(rand, base, routeMeters, points);
      const steps = randomSteps(rand, randRoute);
      const eventCount = 1 + Math.floor(rand() * 8);
      const events = Array.from({ length: eventCount }, (_, i) =>
        randomEvent(rand, base, `r${seed}-${i}`, routeMeters),
      );
      const currentAlongMeters = (rand() - 0.1) * routeMeters;
      const opts: ProjectEventsOptions = { routeSteps: steps };

      const actual = projectEventsToRoute(events, randRoute, currentAlongMeters, opts);
      const expected = legacyProjectEventsToRoute(events, randRoute, currentAlongMeters, opts);
      expect(actual).toEqual(expected);
    }
  });
});

describe("projectEventsToRoute matcher preparation", () => {
  it("prepares exactly one route matcher and one matcher per eligible named step, never per event, coordinate, or sample", () => {
    // A route array with an identity of its own — not the shared module-level
    // `route` fixture, which earlier tests in this file may have already
    // caused `prepareRouteMatcher` to cache before counting was switched on.
    const freshRoute: LngLat[] = [
      [13.0, 52.0],
      [13.1, 52.0],
    ];
    const steps: RouteStep[] = [
      {
        instruction: "",
        distance: 0,
        duration: 0,
        coordinates: [
          [13.01, 52.0],
          [13.03, 52.0],
        ],
        roadNames: ["Road A"],
      },
      {
        instruction: "",
        distance: 0,
        duration: 0,
        coordinates: [
          [13.04, 52.0],
          [13.06, 52.0],
        ],
        roadNames: ["Road B"],
      },
      {
        instruction: "",
        distance: 0,
        duration: 0,
        coordinates: [
          [13.07, 52.0],
          [13.09, 52.0],
        ],
        roadNames: ["Road C"],
      },
    ];
    const pointEvents = Array.from({ length: 4 }, (_, i) =>
      ev(`p${i}`, "high", { type: "Point", coordinates: [13.05, 52.00008] }, "accident", {
        roads: [{ name: "Road A" }],
      }),
    );
    // A single long segment forces many samples (well over one) so the test
    // proves the matcher isn't rebuilt per sample either.
    const lineEvent = ev(
      "line0",
      "medium",
      {
        type: "LineString",
        coordinates: [
          [13.0, 52.00008],
          [13.1, 52.00008],
        ],
      },
      "congestion",
      { roads: [{ name: "Road B" }] },
    );

    resetRouteMatcherCounters();
    setRouteMatcherCounting(true);
    try {
      projectEventsToRoute([...pointEvents, lineEvent], freshRoute, 0, { routeSteps: steps });
      // 1 route matcher + 3 step matchers, regardless of 5 events and 64 line samples.
      expect(readRouteMatcherCounters().preparations).toBe(1 + steps.length);

      resetRouteMatcherCounters();
      // Re-running against the same route/step identities with far more events
      // must build nothing new: `prepareRouteMatcher` is cache-keyed on array
      // identity, so a rebuild here would mean something is being prepared per
      // event rather than once per call.
      const manyEvents = [...pointEvents, ...pointEvents, ...pointEvents, lineEvent];
      projectEventsToRoute(manyEvents, freshRoute, 0, { routeSteps: steps });
      expect(readRouteMatcherCounters().preparations).toBe(0);
    } finally {
      setRouteMatcherCounting(false);
      resetRouteMatcherCounters();
    }
  });

  it("scales to a 5,000-point route with 20 line events without a full-route scan per sample", () => {
    const points = 5000;
    const meters = 400_000;
    const base: LngLat = [13, 52];
    const bigRoute = randomRoute(mulberry32(0x51ee7), base, meters, points);
    const events = Array.from({ length: 20 }, (_, i) => {
      const along = (meters * i) / 20;
      return ev(
        `line${i}`,
        "medium",
        {
          type: "LineString",
          coordinates: [offsetLngLat(base, along, 5), offsetLngLat(base, along + 200, 5)],
        },
        "congestion",
      );
    });

    resetRouteMatcherCounters();
    setRouteMatcherCounting(true);
    const start = performance.now();
    let out: IncidentAlert[];
    try {
      out = projectEventsToRoute(events, bigRoute, 0, { lookaheadMeters: meters + 1000 });
    } finally {
      const durationMs = performance.now() - start;
      const taken = readRouteMatcherCounters();
      if (process.env.OPENMAPX_MATCHER_BENCH) {
        console.info(
          `[incidentProjection] ${points} pts, 20 line events: ${durationMs.toFixed(1)} ms, ` +
            `preparations ${taken.preparations}, snaps ${taken.snaps}, ` +
            `evaluatedEdges/snap ${(taken.evaluatedEdges / taken.snaps).toFixed(1)}`,
        );
      }
      // Exactly the route matcher — no named steps were supplied, and 20 events
      // never cost more than a single preparation.
      expect(taken.preparations).toBe(1);
      // 20 line events × at most 64 samples each; nothing scans per point of
      // the 5,000-vertex route.
      expect(taken.snaps).toBeLessThanOrEqual(20 * 64);
      expect(taken.snaps).toBeGreaterThan(0);
      // A whole-route scan would evaluate ~4,999 edges per snap.
      expect(taken.evaluatedEdges / taken.snaps).toBeLessThan(200);
      setRouteMatcherCounting(false);
      resetRouteMatcherCounters();
    }
    expect(out.length).toBeGreaterThan(0);
  });
});
