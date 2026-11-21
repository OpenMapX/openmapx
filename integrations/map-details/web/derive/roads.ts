import type { TileFeature } from "./decode";
import { bufferPolyline, type Pt, type Ring } from "./geometry";
import { laneCount, laneList, roadWidth } from "./validate";

/**
 * Real-width road model (spec §5.2). Geometry is in metres in the tile frame
 * (x east, y south); lane offsets are measured from the travel-oriented line,
 * positive to the right.
 */

export type PaintKind =
  | "surface"
  | "surface_major"
  | "bus"
  | "cycle"
  | "rail_band"
  | "rail"
  | "path_bridge"
  | "path_bridge_edge"
  | "marking"
  | "arrow"
  | "pitch";

export interface PaintPolygon {
  kind: PaintKind;
  layer: number;
  rings: Ring[];
}

export interface Lane {
  kind: "general" | "bus" | "cycle";
  dir: "fw" | "bw";
  /** Lane centre offset from the travel-oriented line, metres, positive right. */
  offset: number;
  width: number;
  /** Turn values of this lane from a valid `turn:lanes*` list, else null. */
  turn: string[] | null;
  /** Cycle lanes: `cycleway:*:lane=exclusive`, drawn with a solid edge line. */
  exclusive?: boolean;
}

export interface CrossSection {
  lanes: Lane[];
  width: number;
  marked: boolean;
  oneway: boolean;
  /** The line must be reversed before use (`oneway=-1`); sides and directions already account for it. */
  reversed: boolean;
}

type Props = TileFeature["props"];

const PATH_CLASSES = new Set(["footway", "path", "cycleway", "pedestrian", "steps"]);
const MINOR_CLASSES = new Set(["residential", "unclassified", "living_street", "service"]);
const BUS_WIDTH = 3.25;
const CYCLE_WIDTH = 1.5;

export function isMotorRoad(props: Props): boolean {
  return !PATH_CLASSES.has(String(props.class));
}

function baseClass(cls: string): string {
  return cls.endsWith("_link") ? cls.slice(0, -5) : cls;
}

export function isMajorClass(cls: string): boolean {
  const base = baseClass(cls);
  return base === "motorway" || base === "trunk";
}

function generalWidth(cls: string): number {
  const base = baseClass(cls);
  if (base === "motorway" || base === "trunk") return 3.5;
  if (base === "primary" || base === "secondary") return 3.25;
  if (base === "tertiary" || base === "service") return 3;
  return 2.75;
}

function defaultCounts(cls: string, oneway: boolean): [number, number] {
  if (cls === "service") return [1, 0];
  const perDirection = cls === "motorway" || cls === "trunk" ? 2 : 1;
  return oneway ? [perDirection, 0] : [perDirection, perDirection];
}

const SWAPS: Record<string, string> = { _l: "_r", _r: "_l", _fw: "_bw", _bw: "_fw" };

/** Read a side- or direction-suffixed tag as seen along the travel direction. */
function reader(props: Props, reversed: boolean) {
  return (key: string) => {
    if (!reversed) return props[key];
    const suffix = Object.keys(SWAPS).find((s) => key.endsWith(s));
    return props[suffix ? key.slice(0, -suffix.length) + SWAPS[suffix] : key];
  };
}

function turnValues(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  return value
    .split(";")
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

function lanesFor(
  dir: "fw" | "bw",
  count: number,
  width: number,
  turns: string[] | null,
  bus: string[] | null,
): Lane[] {
  return Array.from({ length: count }, (_, i) => ({
    kind: bus?.[i] === "designated" ? ("bus" as const) : ("general" as const),
    dir,
    offset: 0,
    width: bus?.[i] === "designated" ? BUS_WIDTH : width,
    turn: turnValues(turns?.[i]),
  }));
}

/** The cross-section of a motor road from its tags (spec §5.2). */
export function crossSection(props: Props, leftHand: boolean): CrossSection {
  const cls = String(props.class ?? "");
  const reversed = props.oneway === -1;
  const oneway = props.oneway === 1 || reversed;
  const get = reader(props, reversed);
  const kerb = leftHand ? "l" : "r";

  let fw = laneCount(get("lanes_fw"));
  let bw = laneCount(get("lanes_bw"));
  const total = laneCount(props.lanes);
  const [defaultFw, defaultBw] = defaultCounts(cls, oneway);
  const mapped = fw !== null || bw !== null || total !== null;
  if (fw !== null || bw !== null) {
    if (fw === null) fw = total !== null && total > (bw ?? 0) ? total - (bw ?? 0) : defaultFw;
    if (bw === null) bw = oneway ? 0 : total !== null && total > fw ? total - fw : defaultBw;
  } else if (total !== null) {
    bw = oneway ? 0 : Math.floor(total / 2);
    fw = total - bw;
  } else {
    fw = defaultFw;
    bw = defaultBw;
  }

  const width = generalWidth(cls);
  const fwTurn = oneway
    ? (laneList(get("turn"), fw) ?? laneList(get("turn_fw"), fw))
    : laneList(get("turn_fw"), fw);
  const bwTurn = oneway ? null : laneList(get("turn_bw"), bw);
  const fwBus = oneway
    ? (laneList(get("bus_lanes"), fw) ?? laneList(get("bus_lanes_fw"), fw))
    : laneList(get("bus_lanes_fw"), fw);
  const bwBus = oneway ? null : laneList(get("bus_lanes_bw"), bw);
  const forward = lanesFor("fw", fw, width, fwTurn, fwBus);
  // Backward lanes list left to right as seen by backward traffic, the reverse of the forward view.
  const backward = lanesFor("bw", bw, width, bwTurn, bwBus).reverse();
  const row = leftHand ? [...forward, ...backward] : [...backward, ...forward];

  if (cls === "busway") {
    for (const lane of row) {
      lane.kind = "bus";
      lane.width = BUS_WIDTH;
    }
  } else if (!fwBus && !bwBus) {
    const sideBus = (side: "l" | "r") =>
      get(`busway_${side}`) === "lane" ||
      get("busway_both") === "lane" ||
      (get("busway") === "lane" && (!oneway || side === kerb));
    const lanesBus = laneCount(props.lanes_bus);
    if (sideBus("l") || sideBus("r")) {
      for (const side of ["l", "r"] as const) {
        if (!sideBus(side)) continue;
        const edge = side === "l" ? row[0] : row[row.length - 1];
        if (mapped && edge && edge.kind === "general") {
          edge.kind = "bus";
          edge.width = BUS_WIDTH;
        } else if (!mapped) {
          const lane: Lane = {
            kind: "bus",
            dir: edge?.dir ?? "fw",
            offset: 0,
            width: BUS_WIDTH,
            turn: null,
          };
          if (side === "l") row.unshift(lane);
          else row.push(lane);
        }
      }
    } else if (lanesBus !== null) {
      const kerbward = leftHand ? forward : [...forward].reverse();
      for (const lane of kerbward.slice(0, lanesBus)) {
        lane.kind = "bus";
        lane.width = BUS_WIDTH;
      }
    }
  }

  const cycle = get("cycle");
  const sideCycle = (side: "l" | "r") =>
    get(`cycle_${side}`) === "lane" ||
    get("cycle_both") === "lane" ||
    (cycle === "lane" && (!oneway || side === kerb));
  const opposite = oneway && cycle === "opposite_lane" ? (leftHand ? "r" : "l") : null;
  for (const side of ["l", "r"] as const) {
    if (!sideCycle(side) && opposite !== side) continue;
    const edge = side === "l" ? row[0] : row[row.length - 1];
    const lane: Lane = {
      kind: "cycle",
      dir: opposite === side ? "bw" : (edge?.dir ?? "fw"),
      offset: 0,
      width: CYCLE_WIDTH,
      turn: null,
      exclusive:
        get(`cycle_lane_${side}`) === "exclusive" || get("cycle_lane_both") === "exclusive",
    };
    if (side === "l") row.unshift(lane);
    else row.push(lane);
  }

  const natural = row.reduce((sum, lane) => sum + lane.width, 0);
  const mappedWidth = roadWidth(props.width);
  const scale = mappedWidth !== null && natural > 0 ? mappedWidth / natural : 1;
  const totalWidth = natural * scale;
  let left = -totalWidth / 2;
  for (const lane of row) {
    lane.width *= scale;
    lane.offset = left + lane.width / 2;
    left += lane.width;
  }

  const anyTurn = ["turn", "turn_fw", "turn_bw"].some(
    (key) => typeof props[key] === "string" && props[key] !== "",
  );
  const marked =
    mapped &&
    props.lane_markings !== "no" &&
    (!MINOR_CLASSES.has(cls) || props.lane_markings === "yes" || anyTurn);

  return { lanes: row, width: totalWidth, marked, oneway, reversed };
}

/** A feature's lines in metres in the tile frame, oriented along travel when `reversed`. */
export function linesInMetres(feature: TileFeature, mpu: number, reversed = false): Pt[][] {
  return feature.geometry.map((line) => {
    const points = line.map(([x, y]): Pt => [x * mpu, y * mpu]);
    return reversed ? points.reverse() : points;
  });
}

export function layerOf(props: Props): number {
  return typeof props.layer === "number" && Number.isFinite(props.layer) ? props.layer : 0;
}

/** Road surfaces at their real width; motorways and trunks in the major colour. */
export function roadSurfaces(roads: TileFeature[], mpu: number, leftHand: boolean): PaintPolygon[] {
  const out: PaintPolygon[] = [];
  for (const road of roads) {
    if (road.type !== 2 || !isMotorRoad(road.props)) continue;
    const section = crossSection(road.props, leftHand);
    const rings = linesInMetres(road, mpu).flatMap((line) =>
      bufferPolyline(line, section.width / 2),
    );
    if (rings.length === 0) continue;
    out.push({
      kind: isMajorClass(String(road.props.class)) ? "surface_major" : "surface",
      layer: layerOf(road.props),
      rings,
    });
  }
  return out;
}
