import type { DecodedTile, TileFeature } from "./decode";
import { type Instances, InstanceWriter, type ModelKind } from "./forest";
import { distanceToPolyline, type Pt, pointAlong, polylineLength } from "./geometry";
import { hash2, unit } from "./hash";
import { crossSection, isMotorRoad } from "./roads";
import { metresPerUnit } from "./units";
import { direction, signalDirection, treeCirc, treeCrown, treeHeight } from "./validate";

/**
 * Street trees, lamps, traffic signals and benches from the street detail
 * tile of a z16 cell (spec §5.9). Positions are scene metres: x east, y north
 * of the cell's south-west corner. Headings rotate the model's +y (its front)
 * counter-clockwise from north.
 */

const ROW_SPACING_M = 8;
const ROW_JITTER_M = 1;
const DEFAULT_TREE_HEIGHT_M = 10;
const CROWN_PER_HEIGHT = 0.6;
const TRUNK_TO_HEIGHT = 46;
const LAMP_HEIGHT_M = 6;
const SIGNAL_HEIGHT_M = 3.5;
const BENCH_HEIGHT_M = 0.9;
const LAMP_ROAD_RADIUS_M = 15;
const SIGNAL_ROAD_RADIUS_M = 3;
const BENCH_ROAD_RADIUS_M = 10;
const BENCH_MIN_DISTANCE_M = 1;
const VERTEX_TOLERANCE_UNITS = 0.5;

interface SceneRoad {
  feature: TileFeature;
  /** Scene metres, oriented along travel. */
  lines: Pt[][];
  /** Tile units, oriented along travel. */
  tileLines: Pt[][];
  width: number;
  oneway: boolean;
  motor: boolean;
}

/** Heading that turns a model's front (+y) to face along `v`. */
const headingAlong = (v: Pt) => Math.atan2(v[1], v[0]) - Math.PI / 2;

/**
 * Derive the street objects whose anchors lie inside the cell; `street` is the
 * cell's own z16 street detail tile.
 */
export function streetObjects(
  street: DecodedTile,
  cell: { x: number; y: number },
  leftHand: boolean,
): Instances[] {
  const extent = street.extent;
  const mpu = metresPerUnit(16, cell.y, extent);
  const size = extent * mpu;
  const toScene = ([px, py]: Pt): Pt => [px * mpu, (extent - py) * mpu];
  const inCell = ([x, y]: Pt) => x >= 0 && x < size && y >= 0 && y < size;
  const writer = new InstanceWriter();
  const place = (
    kind: ModelKind,
    at: Pt,
    heading: number,
    height: number,
    crown: number,
    h: number,
  ) => {
    if (inCell(at))
      writer.push(kind, [at[0], at[1], heading, height, crown, Math.floor(unit(h, 7) * 4), 0, 1]);
  };

  const roads: SceneRoad[] = (street.layers.roads ?? [])
    .filter((road) => road.type === 2)
    .map((road) => {
      const section = crossSection(road.props, leftHand);
      const tileLines = road.geometry.map((line) =>
        section.reversed ? [...line].reverse() : line,
      );
      return {
        feature: road,
        tileLines,
        lines: tileLines.map((line) => line.map(toScene)),
        width: section.width,
        oneway: section.oneway,
        motor: isMotorRoad(road.props),
      };
    });
  const nearestRoad = (p: Pt, radius: number, motorOnly: boolean) => {
    let best: { d: number; point: Pt; road: SceneRoad } | null = null;
    for (const road of roads) {
      if (motorOnly && !road.motor) continue;
      for (const line of road.lines) {
        const hit = distanceToPolyline(p, line);
        if (hit.d > radius || (best && hit.d >= best.d)) continue;
        const a = line[hit.segment] as Pt;
        const b = line[hit.segment + 1] as Pt;
        best = {
          d: hit.d,
          point: [a[0] + (b[0] - a[0]) * hit.t, a[1] + (b[1] - a[1]) * hit.t],
          road,
        };
      }
    }
    return best;
  };

  for (const tree of street.layers.trees ?? []) {
    const conifer = tree.props.leaf === "needleleaved";
    const kind: ModelKind = conifer ? "conifer" : "broadleaf";
    const mappedHeight = treeHeight(tree.props.height);
    const mappedCrown = treeCrown(tree.props.crown);
    const circ = treeCirc(tree.props.circ);
    if (tree.type === 1) {
      const height =
        mappedHeight ??
        (mappedCrown !== null ? mappedCrown / CROWN_PER_HEIGHT : null) ??
        (circ !== null ? (circ / Math.PI) * TRUNK_TO_HEIGHT : null) ??
        DEFAULT_TREE_HEIGHT_M;
      const crown = mappedCrown ?? CROWN_PER_HEIGHT * height;
      for (const p of tree.geometry.flat()) {
        const h = hash2(p[0], p[1]);
        place(kind, toScene(p), 2 * Math.PI * unit(h, 5), height, crown, h);
      }
    } else if (tree.type === 2) {
      const height = mappedHeight ?? DEFAULT_TREE_HEIGHT_M;
      const crown = mappedCrown ?? CROWN_PER_HEIGHT * height;
      for (const tileLine of tree.geometry) {
        const first = tileLine[0];
        if (!first) continue;
        const line = tileLine.map(toScene);
        const length = polylineLength(line);
        const h = hash2(first[0], first[1]);
        for (let k = 0; k * ROW_SPACING_M <= length; k++) {
          const s = Math.min(
            length,
            Math.max(0, k * ROW_SPACING_M + (unit(h, k) - 0.5) * 2 * ROW_JITTER_M),
          );
          const tk = hash2(h, k);
          place(kind, pointAlong(line, s).point, 2 * Math.PI * unit(tk, 5), height, crown, tk);
        }
      }
    }
  }

  for (const item of street.layers.furniture ?? []) {
    if (item.type !== 1) continue;
    for (const raw of item.geometry.flat()) {
      const at = toScene(raw);
      const h = hash2(raw[0], raw[1]);
      const randomHeading = 2 * Math.PI * unit(h, 5);
      if (item.props.kind === "lamp") {
        const mount = item.props.mount;
        if (mount === "wall" || mount === "suspended") continue;
        const kind: ModelKind = mount === "straight_mast" ? "lamp_lantern" : "lamp_arm";
        const road = nearestRoad(at, LAMP_ROAD_RADIUS_M, true);
        const heading = road
          ? headingAlong([road.point[0] - at[0], road.point[1] - at[1]])
          : randomHeading;
        place(kind, at, heading, LAMP_HEIGHT_M, LAMP_HEIGHT_M, h);
      } else if (item.props.kind === "bench") {
        const road = nearestRoad(at, BENCH_ROAD_RADIUS_M, false);
        if (road && road.d < BENCH_MIN_DISTANCE_M) continue;
        const bearing = direction(item.props.dir);
        const heading =
          bearing !== null
            ? (-bearing * Math.PI) / 180
            : road
              ? headingAlong([at[0] - road.point[0], at[1] - road.point[1]])
              : randomHeading;
        place("bench", at, heading, BENCH_HEIGHT_M, BENCH_HEIGHT_M, h);
      } else if (item.props.kind === "signals") {
        placeSignals(raw, at, h, randomHeading, item.props.sig_dir);
      }
    }
  }

  function placeSignals(
    raw: Pt,
    at: Pt,
    h: number,
    randomHeading: number,
    sigDir: TileFeature["props"][string] | undefined,
  ) {
    // The road the node lies on mid-way honours traffic_signals:direction; at a
    // road's end (a junction) the nearest road is used and the direction ignored.
    let chosen: { road: SceneRoad; travel: Pt } | null = null;
    for (const road of roads) {
      if (!road.motor || chosen) continue;
      road.tileLines.forEach((line, lineIndex) => {
        if (chosen) return;
        const k = line.findIndex(
          (p) =>
            Math.abs(p[0] - raw[0]) <= VERTEX_TOLERANCE_UNITS &&
            Math.abs(p[1] - raw[1]) <= VERTEX_TOLERANCE_UNITS,
        );
        if (k <= 0 || k >= line.length - 1) return;
        const scene = road.lines[lineIndex] as Pt[];
        const a = scene[k - 1] as Pt;
        const b = scene[k + 1] as Pt;
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        chosen = { road, travel: [(b[0] - a[0]) / length, (b[1] - a[1]) / length] };
      });
    }
    let honour = chosen !== null;
    if (!chosen) {
      const nearest = nearestRoad(at, SIGNAL_ROAD_RADIUS_M, true);
      if (!nearest) {
        place("signal", at, randomHeading, SIGNAL_HEIGHT_M, SIGNAL_HEIGHT_M, h);
        return;
      }
      const line = nearest.road.lines.find((l) => distanceToPolyline(at, l).d === nearest.d) ?? [];
      const hit = distanceToPolyline(at, line);
      const a = line[hit.segment] as Pt;
      const b = line[hit.segment + 1] as Pt;
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      chosen = { road: nearest.road, travel: [(b[0] - a[0]) / length, (b[1] - a[1]) / length] };
      honour = false;
    }
    const { road, travel } = chosen as { road: SceneRoad; travel: Pt };
    const which = honour ? signalDirection(sigDir) : "both";
    // Facing travel, the right edge is (ty, −tx) with y north; forward traffic keeps right
    // unless traffic keeps left.
    const right: Pt = [travel[1], -travel[0]];
    const forwardSide: Pt = leftHand ? [-right[0], -right[1]] : right;
    const half = road.width / 2;
    if (which !== "backward")
      place(
        "signal",
        [at[0] + forwardSide[0] * half, at[1] + forwardSide[1] * half],
        headingAlong([-travel[0], -travel[1]]),
        SIGNAL_HEIGHT_M,
        SIGNAL_HEIGHT_M,
        h,
      );
    if (!road.oneway && which !== "forward")
      place(
        "signal",
        [at[0] - forwardSide[0] * half, at[1] - forwardSide[1] * half],
        headingAlong(travel),
        SIGNAL_HEIGHT_M,
        SIGNAL_HEIGHT_M,
        hash2(h, 1),
      );
  }

  return writer.finish();
}
