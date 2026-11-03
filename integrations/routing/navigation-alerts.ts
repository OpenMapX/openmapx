import { haversineDistance, type LngLat } from "@openmapx/core";

/**
 * `GET /navigation/alerts` — approach hazards from OpenStreetMap (stop signs,
 * level crossings, speed bumps, speed cameras) inside a bounding box.
 *
 * A hazard only concerns a driver who travels along the road that carries it,
 * and often only in one direction: a stop sign mapped on a side street a few
 * metres before a junction must not warn the driver on the priority road, and
 * `direction=forward` limits it to traffic following the way's digitisation.
 * So each hazard carries its roads — the OSM ways it sits on, as a short slice
 * of geometry around it — and, per road, whether it applies to traffic
 * travelling that way forward and/or backward as it reaches the hazard. The
 * client then accepts a hazard only when the route arrives at it along one of
 * those roads in an applicable direction (`projectRoadAlertsOntoRoute` in
 * `@openmapx/core`); OSM tagging semantics stay here, in one place.
 */

export type RoadAlertType = "speed_camera" | "railway_crossing" | "stop" | "traffic_calming";

/** A road carrying a hazard, and the travel directions along it the hazard applies to. */
export interface RoadAlertRoad {
  /** OSM way id. */
  wayId: number;
  /**
   * The way's geometry up to {@link ROAD_CONTEXT_REACH_M} either side of the
   * hazard, in the way's digitisation order.
   */
  line: LngLat[];
  /** Index of the hazard's position on this road within `line`. */
  anchorIndex: number;
  /** Applies to traffic travelling in the way's digitisation direction. */
  forward: boolean;
  /** Applies to traffic travelling against the way's digitisation direction. */
  backward: boolean;
}

/** An approach hazard before it is projected onto a route. */
export interface RawRoadAlert {
  id: string;
  type: RoadAlertType;
  /** The mapped OSM node position. */
  lat: number;
  lng: number;
  speedLimitKmh?: number;
  /** Never empty: a hazard on no applicable road is not returned. */
  roads: RoadAlertRoad[];
}

export interface AlertBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/**
 * How far each road slice reaches either side of its hazard, metres. The client
 * looks up to 30 m back along the road for evidence that the route arrives
 * along it, so this must stay above that.
 */
export const ROAD_CONTEXT_REACH_M = 35;
/** An undirected stop applies toward a junction no further than this along its road. */
const JUNCTION_SEARCH_M = 40;
/** A hazard mapped beside the road attaches to roads within this distance. */
const OFF_ROAD_SNAP_M = 15;
/** …and only to those no more than this further away than the nearest one. */
const OFF_ROAD_TIE_M = 3;

/**
 * `traffic_calming` values that change the road's height — what the "speed
 * bump" alert announces. Lateral devices (chicane, choker, island) and painted
 * markings are not announced.
 */
const VERTICAL_CALMING = new Set([
  "bump",
  "mini_bumps",
  "hump",
  "table",
  "cushion",
  "rumble_strip",
  "dip",
  "double_dip",
  "dynamic_bump",
  "choked_table",
  "choked_cushion",
  "choked_hump",
]);

/** Railway values whose track no longer (or not yet) carries trains. */
const INACTIVE_RAILWAY = new Set([
  "abandoned",
  "disused",
  "razed",
  "dismantled",
  "proposed",
  "construction",
]);

/**
 * Relative importance of drivable road classes. At a junction the lower-ranked
 * approaches are the ones a stop sign mapped on the junction node itself can
 * apply to. Ways absent from this table do not count as roads at a junction.
 */
const ROAD_RANK: Record<string, number> = {
  motorway: 13,
  trunk: 12,
  primary: 11,
  secondary: 10,
  tertiary: 9,
  motorway_link: 8,
  trunk_link: 8,
  primary_link: 7,
  secondary_link: 7,
  tertiary_link: 6,
  unclassified: 5,
  residential: 4,
  living_street: 3,
  road: 3,
  busway: 3,
  service: 2,
  track: 1,
};

type Direction = "forward" | "backward" | "both";
interface Flags {
  forward: boolean;
  backward: boolean;
}

/** An element of the Overpass answer, as far as this module reads it. */
export interface AlertOverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  nodes?: number[];
  geometry?: ({ lat: number; lon: number } | null)[];
}

interface Way {
  id: number;
  tags: Record<string, string>;
  nodes: number[];
  /** Aligned with `nodes`; absent for ways fetched only for their topology. */
  coords?: LngLat[];
}

/**
 * One Overpass query for every hazard in the box and the context needed to
 * resolve it: the highway ways each hazard sits on (with geometry), the
 * railways at level crossings (lifecycle), the ways around undirected stop
 * signs (to find the junction they face) and roads near hazards mapped beside
 * the road.
 */
export function buildNavigationAlertsQuery({ south, west, north, east }: AlertBounds): string {
  const b = `${south},${west},${north},${east}`;
  const explicitDirection = "^(forward|backward|both)$";
  return [
    "[out:json][timeout:25];",
    `(node["highway"="speed_camera"](${b});node["railway"="level_crossing"](${b});`,
    `node["highway"="stop"](${b});node["traffic_calming"](${b});)->.alerts;`,
    ".alerts out body;",
    'way(bn.alerts)["highway"]->.roads;',
    ".roads out body geom;",
    'node.alerts["railway"="level_crossing"]->.crossings;',
    'way(bn.crossings)["railway"];',
    "out body;",
    `node.alerts["highway"="stop"]["stop"!="all"]["direction"!~"${explicitDirection}"]`,
    `["stop:direction"!~"${explicitDirection}"]->.undirected;`,
    'way(bn.undirected)["highway"]->.undirectedRoads;',
    `node(w.undirectedRoads)(around.undirected:${JUNCTION_SEARCH_M})->.near;`,
    'way(bn.near)["highway"];',
    "out body;",
    "node(w.roads)->.onRoad;",
    "(.alerts; - .onRoad;)->.offRoad;",
    `way(around.offRoad:${OFF_ROAD_SNAP_M})["highway"];`,
    "out body geom;",
  ].join("");
}

/** Parse an OSM `maxspeed` tag to km/h, or undefined when not a plain number. */
function parseMaxspeedKmh(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function alertType(tags: Record<string, string>): RoadAlertType | null {
  if (tags.highway === "speed_camera") return "speed_camera";
  if (tags.railway === "level_crossing") return "railway_crossing";
  if (tags.highway === "stop") return "stop";
  const calming = tags.traffic_calming;
  if (calming?.split(";").some((value) => VERTICAL_CALMING.has(value.trim()))) {
    return "traffic_calming";
  }
  return null;
}

/**
 * The travel direction a node on a way applies to, from `stop:direction`
 * (stop signs) or `direction`. Compass and numeric values describe a sign
 * standing beside the road, which this cannot place on a carriageway, so they
 * count as unknown.
 */
function explicitDirection(tags: Record<string, string>, type: RoadAlertType): Direction | null {
  const candidates = type === "stop" ? [tags["stop:direction"], tags.direction] : [tags.direction];
  for (const value of candidates) {
    if (value === "forward" || value === "backward" || value === "both") return value;
  }
  return null;
}

function flagsFor(direction: Direction | null): Flags {
  return {
    forward: direction !== "backward",
    backward: direction !== "forward",
  };
}

function intersect(a: Flags, b: Flags): Flags {
  return { forward: a.forward && b.forward, backward: a.backward && b.backward };
}

/** Directions from which a way reaches the node at `index`; a closed way reaches every node both ways. */
function approachFlags(way: Way, index: number): Flags {
  if (isClosed(way)) return { forward: true, backward: true };
  return { forward: index > 0, backward: index < way.nodes.length - 1 };
}

function isClosed(way: Way): boolean {
  return way.nodes.length > 3 && way.nodes[0] === way.nodes[way.nodes.length - 1];
}

function isDrivable(way: Way): boolean {
  return way.tags.highway !== undefined && way.tags.highway in ROAD_RANK;
}

/**
 * Ways a hazard can be met on: roads, plus cycleways for bicycle routes.
 * Footways and paths crossing a road at a speed bump or level crossing are
 * not where a vehicle meets it.
 */
function carriesTraffic(way: Way): way is Way & { coords: LngLat[] } {
  return !!way.coords && (isDrivable(way) || way.tags.highway === "cycleway");
}

/** Drivable road segments meeting at `nodeId`; three or more make a junction. */
function junctionDegree(nodeId: number, waysByNode: Map<number, Way[]>): number {
  let degree = 0;
  for (const way of waysByNode.get(nodeId) ?? []) {
    if (!isDrivable(way)) continue;
    way.nodes.forEach((id, index) => {
      if (id !== nodeId) return;
      if (index > 0) degree++;
      if (index < way.nodes.length - 1) degree++;
    });
  }
  return degree;
}

/**
 * Distance along `way` from node `index` to the first junction in the given
 * direction, within {@link JUNCTION_SEARCH_M}; null when there is none.
 */
function distanceToJunction(
  way: Way & { coords: LngLat[] },
  index: number,
  step: 1 | -1,
  waysByNode: Map<number, Way[]>,
): number | null {
  let travelled = 0;
  for (let i = index + step; i >= 0 && i < way.nodes.length; i += step) {
    travelled += haversineDistance(way.coords[i - step], way.coords[i]);
    if (travelled > JUNCTION_SEARCH_M) return null;
    if (junctionDegree(way.nodes[i], waysByNode) >= 3) return travelled;
  }
  return null;
}

/**
 * An undirected stop sign between junctions is meant for the traffic heading
 * to the nearer one (the sign stands at its stop line). With no junction close
 * by, or two equally close, it applies both ways.
 *
 * The road can continue on another way at the sign's node (a way split where a
 * speed limit changes, say), so each way leaving the node is one side to look
 * along. Traffic heading for the nearer side travels toward the node on every
 * other side and away from it on the nearer one; the flags say so per way.
 */
function inferredStopFlags(
  nodeId: number,
  parents: (Way & { coords: LngLat[] })[],
  waysByNode: Map<number, Way[]>,
): Map<Way, Flags> {
  const sides: { way: Way & { coords: LngLat[] }; step: 1 | -1; distance: number | null }[] = [];
  for (const way of parents) {
    way.nodes.forEach((id, index) => {
      if (id !== nodeId) return;
      if (index < way.nodes.length - 1) {
        sides.push({ way, step: 1, distance: distanceToJunction(way, index, 1, waysByNode) });
      }
      if (index > 0) {
        sides.push({ way, step: -1, distance: distanceToJunction(way, index, -1, waysByNode) });
      }
    });
  }
  const both = new Map(parents.map((way) => [way, { forward: true, backward: true }]));
  const found = sides.filter((side) => side.distance !== null) as {
    way: Way & { coords: LngLat[] };
    step: 1 | -1;
    distance: number;
  }[];
  if (found.length === 0) return both;
  found.sort((a, b) => a.distance - b.distance);
  const nearest = found[0];
  if (found[1] && found[1].distance - nearest.distance <= 1) return both;

  const flags = new Map(parents.map((way) => [way, { forward: false, backward: false }]));
  for (const side of sides) {
    const wayFlags = flags.get(side.way);
    if (!wayFlags) continue;
    // Toward the nearer junction: along that side's step on its own way,
    // against the step (toward the node) on every other side.
    const forward = side === nearest ? side.step === 1 : side.step === -1;
    if (forward) wayFlags.forward = true;
    else wayFlags.backward = true;
  }
  return flags;
}

interface Placement {
  way: Way & { coords: LngLat[] };
  /** Node index of an on-road hazard; absent for a hazard projected from beside the road. */
  index?: number;
  flags: Flags;
  anchorAlong: number;
  anchor: LngLat;
}

/**
 * Resolve a hazard sitting on one or more highway ways into per-road flags.
 * A stop sign mapped on a junction node applies to the approaches that are
 * not the junction's main road; elsewhere a tagged direction is taken as
 * written, and an undirected stop sign faces the nearer junction.
 */
function resolveOnRoad(
  type: RoadAlertType,
  tags: Record<string, string>,
  nodeId: number,
  parents: (Way & { coords: LngLat[] })[],
  waysByNode: Map<number, Way[]>,
): Placement[] {
  const explicit = explicitDirection(tags, type);
  const placements: Placement[] = [];
  const allWay = type === "stop" && (tags.stop === "all" || explicit === "both");
  const atJunction = type === "stop" && !allWay && junctionDegree(nodeId, waysByNode) >= 3;
  const ranks = parents.filter(isDrivable).map((way) => ROAD_RANK[way.tags.highway]);
  const topRank = Math.max(...ranks);
  const ranked = ranks.some((rank) => rank < topRank);
  const inferred =
    type === "stop" && !allWay && !atJunction && explicit === null
      ? inferredStopFlags(nodeId, parents, waysByNode)
      : null;

  for (const way of parents) {
    const index = way.nodes.indexOf(nodeId);
    let flags: Flags;
    if (atJunction) {
      if (!isDrivable(way)) continue;
      const minorApproach = ranked ? ROAD_RANK[way.tags.highway] < topRank : explicit !== null;
      if (!minorApproach) continue;
      flags = intersect(approachFlags(way, index), flagsFor(explicit));
    } else if (inferred) {
      flags = inferred.get(way) ?? { forward: true, backward: true };
    } else {
      flags = flagsFor(allWay ? "both" : explicit);
    }
    const cum = cumulative(way.coords);
    placements.push({ way, index, flags, anchorAlong: cum[index], anchor: way.coords[index] });
  }
  return placements;
}

/**
 * A hazard mapped beside the road (no highway way carries its node) attaches
 * to the nearest road within {@link OFF_ROAD_SNAP_M}, and to any other road
 * nearly as close. A travel direction relative to a way means nothing for such
 * a node, so it applies both ways; an undirected stop sign between two roads
 * cannot be placed and is dropped.
 */
function resolveOffRoad(
  type: RoadAlertType,
  tags: Record<string, string>,
  position: LngLat,
  roads: (Way & { coords: LngLat[] })[],
): Placement[] {
  const near = roads
    .map((way) => ({ way, projection: projectOntoLine(way.coords, position) }))
    .filter(({ projection }) => projection.distance <= OFF_ROAD_SNAP_M)
    .sort((a, b) => a.projection.distance - b.projection.distance);
  if (near.length === 0) return [];
  const nearest = near[0].projection.distance;
  const candidates = near.filter(
    ({ projection }) => projection.distance <= nearest + OFF_ROAD_TIE_M,
  );
  const allWay =
    type === "stop" && (tags.stop === "all" || explicitDirection(tags, type) === "both");
  if (type === "stop" && !allWay && candidates.length > 1) return [];
  return candidates.map(({ way, projection }) => ({
    way,
    flags: { forward: true, backward: true },
    anchorAlong: projection.along,
    anchor: projection.point,
  }));
}

/**
 * Map the Overpass answer of {@link buildNavigationAlertsQuery} to hazards with
 * their applicable roads. Hazards on no applicable road, speed bumps that are
 * not vertical devices and level crossings of inactive railways are dropped.
 */
export function mapAlertElements(elements: readonly AlertOverpassElement[]): RawRoadAlert[] {
  const alertNodes: AlertOverpassElement[] = [];
  const ways = new Map<number, Way>();
  for (const element of elements) {
    if (element.type === "node") {
      if (element.lat !== undefined && element.lon !== undefined) alertNodes.push(element);
      continue;
    }
    if (element.type !== "way" || !element.nodes || element.nodes.length < 2) continue;
    const coords = toCoords(element);
    const existing = ways.get(element.id);
    if (existing?.coords && !coords) continue;
    ways.set(element.id, {
      id: element.id,
      tags: element.tags ?? {},
      nodes: element.nodes,
      ...(coords ? { coords } : {}),
    });
  }

  const waysByNode = new Map<number, Way[]>();
  for (const way of ways.values()) {
    for (const nodeId of new Set(way.nodes)) {
      const list = waysByNode.get(nodeId);
      if (list) list.push(way);
      else waysByNode.set(nodeId, [way]);
    }
  }
  const roadsWithGeometry = [...ways.values()].filter(carriesTraffic);

  const out: RawRoadAlert[] = [];
  for (const node of alertNodes) {
    const tags = node.tags ?? {};
    const type = alertType(tags);
    if (!type || node.lat === undefined || node.lon === undefined) continue;
    const attached = waysByNode.get(node.id) ?? [];
    if (type === "railway_crossing") {
      const rails = attached.filter((way) => way.tags.railway && !way.tags.highway);
      if (rails.length > 0 && rails.every((way) => INACTIVE_RAILWAY.has(way.tags.railway))) {
        continue;
      }
    }
    const parents = attached.filter(carriesTraffic);
    // A hazard on a footway alone (say a level crossing mapped on the path) is
    // still not beside a road, so it is not placed on one either.
    if (parents.length === 0 && attached.some((way) => way.tags.highway)) continue;
    const placements =
      parents.length > 0
        ? resolveOnRoad(type, tags, node.id, parents, waysByNode)
        : resolveOffRoad(type, tags, [node.lon, node.lat], roadsWithGeometry);

    const roads: RoadAlertRoad[] = [];
    for (const placement of placements) {
      if (!placement.flags.forward && !placement.flags.backward) continue;
      const { line, anchorIndex } = sliceAround(
        placement.way,
        placement.anchorAlong,
        placement.anchor,
      );
      roads.push({ wayId: placement.way.id, line, anchorIndex, ...placement.flags });
    }
    if (roads.length === 0) continue;

    const speedLimitKmh = type === "speed_camera" ? parseMaxspeedKmh(tags.maxspeed) : undefined;
    out.push({
      id: `${type}:${node.id}`,
      type,
      lat: node.lat,
      lng: node.lon,
      ...(speedLimitKmh ? { speedLimitKmh } : {}),
      roads,
    });
  }
  return out;
}

function toCoords(element: AlertOverpassElement): LngLat[] | undefined {
  const geometry = element.geometry;
  if (!geometry || geometry.length !== element.nodes?.length) return undefined;
  const coords: LngLat[] = [];
  for (const point of geometry) {
    if (!point) return undefined;
    coords.push([point.lon, point.lat]);
  }
  return coords;
}

function cumulative(coords: LngLat[]): number[] {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + haversineDistance(coords[i - 1], coords[i]));
  }
  return cum;
}

const METERS_PER_DEGREE_LAT = 110_574;
const METERS_PER_DEGREE_LNG_EQUATOR = 111_320;

/** Nearest point of a polyline to `position`, in a local equirectangular frame. */
function projectOntoLine(
  coords: LngLat[],
  position: LngLat,
): { distance: number; along: number; point: LngLat } {
  const kx = Math.cos((position[1] * Math.PI) / 180) * METERS_PER_DEGREE_LNG_EQUATOR;
  const ky = METERS_PER_DEGREE_LAT;
  const cum = cumulative(coords);
  let best = { distance: Number.POSITIVE_INFINITY, along: 0, point: coords[0] };
  for (let i = 0; i < coords.length - 1; i++) {
    const ax = (coords[i][0] - position[0]) * kx;
    const ay = (coords[i][1] - position[1]) * ky;
    const bx = (coords[i + 1][0] - position[0]) * kx;
    const by = (coords[i + 1][1] - position[1]) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const t =
      lengthSquared > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / lengthSquared)) : 0;
    const px = ax + t * dx;
    const py = ay + t * dy;
    const distance = Math.hypot(px, py);
    if (distance < best.distance) {
      best = {
        distance,
        along: cum[i] + t * (cum[i + 1] - cum[i]),
        point: [
          coords[i][0] + t * (coords[i + 1][0] - coords[i][0]),
          coords[i][1] + t * (coords[i + 1][1] - coords[i][1]),
        ],
      };
    }
  }
  return best;
}

const round7 = (value: number): number => Math.round(value * 1e7) / 1e7;

/**
 * The part of a way within {@link ROAD_CONTEXT_REACH_M} of `anchorAlong`,
 * clipped at interpolated end points, with the anchor as one of its vertices.
 * A closed way (a roundabout) continues through its closing node, so it is
 * unrolled to reach either side of an anchor at or near that node.
 */
function sliceAround(
  way: Way & { coords: LngLat[] },
  wayAnchorAlong: number,
  anchor: LngLat,
): { line: LngLat[]; anchorIndex: number } {
  const closed = isClosed(way);
  const coords = closed
    ? [...way.coords, ...way.coords.slice(1), ...way.coords.slice(1)]
    : way.coords;
  const perimeter = closed ? cumulative(way.coords)[way.coords.length - 1] : 0;
  const anchorAlong = wayAnchorAlong + perimeter;
  const cum = cumulative(coords);
  const total = cum[cum.length - 1];
  const start = Math.max(0, anchorAlong - ROAD_CONTEXT_REACH_M);
  const end = Math.min(total, anchorAlong + ROAD_CONTEXT_REACH_M);
  const pointAt = (along: number): LngLat => {
    let i = 0;
    while (i < cum.length - 2 && cum[i + 1] < along) i++;
    const span = cum[i + 1] - cum[i];
    const t = span > 0 ? (along - cum[i]) / span : 0;
    return [
      coords[i][0] + t * (coords[i + 1][0] - coords[i][0]),
      coords[i][1] + t * (coords[i + 1][1] - coords[i][1]),
    ];
  };

  const before: LngLat[] = [pointAt(start)];
  const after: LngLat[] = [];
  for (let i = 0; i < coords.length; i++) {
    if (cum[i] > start && cum[i] < anchorAlong) before.push(coords[i]);
    else if (cum[i] > anchorAlong && cum[i] < end) after.push(coords[i]);
  }
  after.push(pointAt(end));

  const line: LngLat[] = [];
  const push = (point: LngLat) => {
    const previous = line[line.length - 1];
    if (previous && haversineDistance(previous, point) < 0.05) return;
    line.push([round7(point[0]), round7(point[1])]);
  };
  for (const point of before) push(point);
  // The anchor replaces a coincident neighbour rather than duplicating it.
  const last = line[line.length - 1];
  if (last && haversineDistance(last, anchor) < 0.05) line.pop();
  line.push([round7(anchor[0]), round7(anchor[1])]);
  const anchorIndex = line.length - 1;
  for (const point of after) push(point);
  return { line, anchorIndex };
}
