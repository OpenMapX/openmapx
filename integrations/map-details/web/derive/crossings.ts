import type { TileFeature } from "./decode";
import { distanceToPolyline, type Pt, type Ring } from "./geometry";
import { type CrossSection, isMotorRoad, layerOf, linesInMetres, type PaintPolygon } from "./roads";

/** Pedestrian crossing markings (spec §5.5). Metres in the tile frame. */

type Props = TileFeature["props"];
export type CrossingMarking = "zebra" | "lines" | "dashed_lines";

const ZEBRA_MARKINGS = new Set(["zebra", "yes", "ladder", "ladder:skewed", "ladder:paired"]);
const LINE_MARKINGS = new Set(["lines", "lines:paired"]);
const DASHED_MARKINGS = new Set(["dashes", "dots"]);

const STRIPE_M = 0.5;
const STRIPE_GAP_M = 0.5;
const STRIPE_LENGTH_M = 3;
const LINE_WIDTH_M = 0.2;
const LINE_SPACING_M = 3;
const DOT_M = 0.6;
const NODE_LINE_RADIUS_M = 2;
const NODE_ROAD_RADIUS_M = 3;
const MIN_SINE = 0.3;

/** The marking a crossing gets; the first matching rule of spec §5.5 wins. */
export function crossingMarking(props: Props): CrossingMarking | null {
  const markings = props.markings;
  if (typeof markings === "string" && markings !== "") {
    if (ZEBRA_MARKINGS.has(markings)) return "zebra";
    if (LINE_MARKINGS.has(markings)) return "lines";
    if (DASHED_MARKINGS.has(markings)) return "dashed_lines";
    return null;
  }
  if (props.crossing === "zebra" || props.crossing === "marked" || props.crossing_ref === "zebra")
    return "zebra";
  if (props.crossing === "traffic_signals") return "lines";
  return null;
}

/** A parallelogram centred at `c` with half-extents `a` along `u` and `b` along `v`. */
function box(c: Pt, u: Pt, a: number, v: Pt, b: number): Ring {
  return [
    [c[0] - u[0] * a - v[0] * b, c[1] - u[1] * a - v[1] * b],
    [c[0] + u[0] * a - v[0] * b, c[1] + u[1] * a - v[1] * b],
    [c[0] + u[0] * a + v[0] * b, c[1] + u[1] * a + v[1] * b],
    [c[0] - u[0] * a + v[0] * b, c[1] - u[1] * a + v[1] * b],
  ];
}

const along = (c: Pt, d: Pt, t: number): Pt => [c[0] + d[0] * t, c[1] + d[1] * t];

/**
 * Marking rings for a crossing centred at `centre`: `axis` runs across the
 * carriageway for `half` metres each way, `traffic` along the road.
 */
function markingRings(
  marking: CrossingMarking,
  centre: Pt,
  axis: Pt,
  traffic: Pt,
  half: number,
): Ring[] {
  if (marking === "zebra") {
    const count = Math.floor((2 * half + STRIPE_GAP_M) / (STRIPE_M + STRIPE_GAP_M));
    const span = count * STRIPE_M + (count - 1) * STRIPE_GAP_M;
    return Array.from({ length: count }, (_, i) =>
      box(
        along(centre, axis, -span / 2 + STRIPE_M / 2 + i * (STRIPE_M + STRIPE_GAP_M)),
        axis,
        STRIPE_M / 2,
        traffic,
        STRIPE_LENGTH_M / 2,
      ),
    );
  }
  const rings: Ring[] = [];
  for (const side of [-1, 1]) {
    const middle = along(centre, traffic, (side * LINE_SPACING_M) / 2);
    if (marking === "lines") {
      rings.push(box(middle, axis, half, traffic, LINE_WIDTH_M / 2));
      continue;
    }
    for (let t = -half; t < half - 1e-9; t += 2 * DOT_M) {
      const end = Math.min(t + DOT_M, half);
      rings.push(
        box(along(middle, axis, (t + end) / 2), axis, (end - t) / 2, traffic, LINE_WIDTH_M / 2),
      );
    }
  }
  return rings;
}

function intersect(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const r: Pt = [b[0] - a[0], b[1] - a[1]];
  const s: Pt = [d[0] - c[0], d[1] - c[1]];
  const denominator = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(denominator) < 1e-12) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / denominator;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / denominator;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [a[0] + r[0] * t, a[1] + r[1] * t] : null;
}

const unit = (a: Pt, b: Pt): Pt => {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
};

interface MotorRoad {
  lines: Pt[][];
  section: CrossSection;
  layer: number;
}

/**
 * Crossing markings over the carriageway they cross. A crossing way gives the
 * axis and spans the crossed road's width; a lone crossing node takes the
 * nearest road within 3 m, perpendicular to it. Crossings are not trimmed at
 * junctions.
 */
export function crossingPaint(
  crossings: TileFeature[],
  roads: TileFeature[],
  sections: CrossSection[],
  mpu: number,
): PaintPolygon[] {
  const motor: MotorRoad[] = [];
  roads.forEach((road, index) => {
    const section = sections[index];
    if (road.type === 2 && isMotorRoad(road.props) && section)
      motor.push({ lines: linesInMetres(road, mpu), section, layer: layerOf(road.props) });
  });
  const byLayer = new Map<number, Ring[]>();
  const add = (layer: number, rings: Ring[]) =>
    byLayer.set(layer, [...(byLayer.get(layer) ?? []), ...rings]);

  const crossingLines = crossings
    .filter((feature) => feature.type === 2)
    .map((feature) => ({ feature, lines: linesInMetres(feature, mpu) }));

  for (const { feature, lines } of crossingLines) {
    const marking = crossingMarking(feature.props);
    if (!marking) continue;
    for (const road of motor) {
      let found = false;
      for (const crossing of lines) {
        for (let i = 1; i < crossing.length && !found; i++) {
          const a = crossing[i - 1] as Pt;
          const b = crossing[i] as Pt;
          for (const line of road.lines) {
            for (let j = 1; j < line.length && !found; j++) {
              const c = line[j - 1] as Pt;
              const d = line[j] as Pt;
              const hit = intersect(a, b, c, d);
              if (!hit) continue;
              const axis = unit(a, b);
              const traffic = unit(c, d);
              const sine = Math.max(
                MIN_SINE,
                Math.abs(axis[0] * traffic[1] - axis[1] * traffic[0]),
              );
              add(
                road.layer,
                markingRings(marking, hit, axis, traffic, road.section.width / 2 / sine),
              );
              found = true;
            }
          }
        }
      }
    }
  }

  for (const feature of crossings) {
    if (feature.type !== 1) continue;
    const marking = crossingMarking(feature.props);
    if (!marking) continue;
    for (const point of feature.geometry.flat()) {
      const p: Pt = [point[0] * mpu, point[1] * mpu];
      const nearLine = crossingLines.some(({ lines }) =>
        lines.some((line) => distanceToPolyline(p, line).d <= NODE_LINE_RADIUS_M),
      );
      if (nearLine) continue;
      let best: { d: number; road: MotorRoad; line: Pt[]; segment: number; t: number } | null =
        null;
      for (const road of motor)
        for (const line of road.lines) {
          const hit = distanceToPolyline(p, line);
          if (hit.d <= NODE_ROAD_RADIUS_M && (!best || hit.d < best.d))
            best = { ...hit, road, line };
        }
      if (!best) continue;
      const c = best.line[best.segment] as Pt;
      const d = best.line[best.segment + 1] as Pt;
      const traffic = unit(c, d);
      const centre: Pt = [c[0] + (d[0] - c[0]) * best.t, c[1] + (d[1] - c[1]) * best.t];
      const axis: Pt = [-traffic[1], traffic[0]];
      add(
        best.road.layer,
        markingRings(marking, centre, axis, traffic, best.road.section.width / 2),
      );
    }
  }

  return [...byLayer].map(([layer, rings]) => ({ kind: "marking" as const, layer, rings }));
}
