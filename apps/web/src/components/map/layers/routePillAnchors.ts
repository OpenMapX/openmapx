import type { LngLat, Route } from "@openmapx/core";
import type { MapInsets } from "@/lib/mapObstructions";

interface Point {
  x: number;
  y: number;
}

interface Segment {
  from: LngLat;
  to: LngLat;
  a: Point;
  b: Point;
}

interface Candidate {
  coordinate: LngLat;
  point: Point;
  progress: number;
}

interface PreparedRoute {
  index: number;
  segments: Segment[];
  candidates: Candidate[];
  width: number;
  segmentIndex?: SegmentIndex;
}

export interface RoutePillAnchor {
  routeIndex: number;
  coordinate: LngLat;
}

export interface RoutePillInput {
  routeIndex: number;
  geometry: Route["geometry"];
  /** Conservative rendered width, including horizontal pill padding. */
  width: number;
}

interface Viewport {
  width: number;
  height: number;
  insets: MapInsets;
}

function interpolate(a: LngLat, b: LngLat, t: number): LngLat {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Liang–Barsky clipping, retaining the fraction of the real segment on screen. */
function clipSegment(
  a: Point,
  b: Point,
  rect: { left: number; right: number; top: number; bottom: number },
) {
  let start = 0;
  let end = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (let edge = 0; edge < 4; edge++) {
    const p = edge === 0 ? -dx : edge === 1 ? dx : edge === 2 ? -dy : dy;
    const q =
      edge === 0
        ? a.x - rect.left
        : edge === 1
          ? rect.right - a.x
          : edge === 2
            ? a.y - rect.top
            : rect.bottom - a.y;
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) start = Math.max(start, t);
    else end = Math.min(end, t);
    if (start > end) return null;
  }
  return { start, end };
}

interface SegmentIndex {
  left: number;
  right: number;
  top: number;
  bottom: number;
  start: number;
  end: number;
  children?: readonly [SegmentIndex, SegmentIndex];
}

/** Contiguous segment ranges preserve route order and build in linear time. */
function indexSegments(segments: Segment[], start = 0, end = segments.length): SegmentIndex {
  const node: SegmentIndex = {
    left: Infinity,
    right: -Infinity,
    top: Infinity,
    bottom: -Infinity,
    start,
    end,
  };
  if (end - start > 16) {
    const middle = (start + end) >>> 1;
    const a = indexSegments(segments, start, middle);
    const b = indexSegments(segments, middle, end);
    node.children = [a, b];
    node.left = Math.min(a.left, b.left);
    node.right = Math.max(a.right, b.right);
    node.top = Math.min(a.top, b.top);
    node.bottom = Math.max(a.bottom, b.bottom);
  } else {
    for (let i = start; i < end; i++) {
      const { a, b } = segments[i];
      node.left = Math.min(node.left, a.x, b.x);
      node.right = Math.max(node.right, a.x, b.x);
      node.top = Math.min(node.top, a.y, b.y);
      node.bottom = Math.max(node.bottom, a.y, b.y);
    }
  }
  return node;
}

function distanceToRoute(point: Point, route: PreparedRoute): number {
  if (route.segments.length === 0) return Infinity;
  route.segmentIndex ??= indexSegments(route.segments);
  const root = route.segmentIndex;
  let nearestSquared = Infinity;
  const lowerBound = (node: SegmentIndex): number => {
    const dx = Math.max(node.left - point.x, 0, point.x - node.right);
    const dy = Math.max(node.top - point.y, 0, point.y - node.bottom);
    return dx * dx + dy * dy;
  };
  const visit = (node: SegmentIndex) => {
    if (lowerBound(node) >= nearestSquared) return;
    if (node.children) {
      const [a, b] = node.children;
      // Exact branch-and-bound search, not vertex sampling or simplified lines.
      if (lowerBound(a) <= lowerBound(b)) {
        visit(a);
        visit(b);
      } else {
        visit(b);
        visit(a);
      }
      return;
    }
    for (let i = node.start; i < node.end; i++) {
      const { a, b } = route.segments[i];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lengthSquared = dx * dx + dy * dy;
      if (lengthSquared <= 0) continue;
      const t = Math.max(
        0,
        Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared),
      );
      const x = point.x - (a.x + dx * t);
      const y = point.y - (a.y + dy * t);
      nearestSquared = Math.min(nearestSquared, x * x + y * y);
    }
  };
  visit(root);
  return Math.sqrt(nearestSquared);
}

function overlaps(a: Candidate, widthA: number, b: Candidate, widthB: number): boolean {
  return (
    Math.abs(a.point.x - b.point.x) < (widthA + widthB) / 2 + 12 &&
    Math.abs(a.point.y - b.point.y) < 44
  );
}

/** Place one pill per route on actual visible geometry, with the active pill first. */
export function routePillAnchors(
  routes: RoutePillInput[],
  activeRouteIndex: number,
  project: (coordinate: LngLat) => Point,
  viewport: Viewport,
): RoutePillAnchor[] {
  const prepared: PreparedRoute[] = [];
  for (const route of routes) {
    const halfWidth = Math.max(32, route.width / 2);
    const rect = {
      left: viewport.insets.left + halfWidth + 8,
      right: viewport.width - viewport.insets.right - halfWidth - 8,
      top: viewport.insets.top + 26,
      bottom: viewport.height - viewport.insets.bottom - 26,
    };
    if (rect.left >= rect.right || rect.top >= rect.bottom) continue;
    const segments: Segment[] = [];
    const visible: Array<{ segment: Segment; start: number; end: number; length: number }> = [];
    let previousCoordinate: LngLat | undefined;
    let previousPoint: Point | undefined;
    for (const coordinate of route.geometry) {
      if (!Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1])) {
        previousCoordinate = undefined;
        previousPoint = undefined;
        continue;
      }
      const point = project(coordinate);
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        previousCoordinate = undefined;
        previousPoint = undefined;
        continue;
      }
      const from = previousCoordinate;
      const a = previousPoint;
      previousCoordinate = coordinate;
      previousPoint = point;
      if (!from || !a) continue;
      const length = distance(a, point);
      if (length < 0.01) continue;
      const segment = { from, to: coordinate, a, b: point };
      segments.push(segment);
      const clipped = clipSegment(segment.a, segment.b, rect);
      if (clipped && clipped.end > clipped.start) {
        visible.push({ ...clipped, segment, length: length * (clipped.end - clipped.start) });
      }
    }
    const total = visible.reduce((sum, part) => sum + part.length, 0);
    if (total < 1) continue;
    const candidates: Candidate[] = [];
    let partIndex = 0;
    let traversed = 0;
    // Candidate distances increase monotonically; walk the visible route once.
    for (let step = 1; step <= 39; step++) {
      const progress = step / 40;
      const target = progress * total;
      while (partIndex < visible.length - 1 && target > traversed + visible[partIndex].length) {
        traversed += visible[partIndex++].length;
      }
      const part = visible[partIndex];
      const t = part.start + ((target - traversed) / part.length) * (part.end - part.start);
      const coordinate = interpolate(part.segment.from, part.segment.to, t);
      candidates.push({ coordinate, point: project(coordinate), progress });
    }
    prepared.push({ index: route.routeIndex, segments, candidates, width: route.width });
  }

  const accepted: Array<{ route: PreparedRoute; candidate: Candidate }> = [];
  const active = prepared.find((route) => route.index === activeRouteIndex);
  if (active) {
    const middle = active.candidates.reduce((best, candidate) =>
      Math.abs(candidate.progress - 0.5) < Math.abs(best.progress - 0.5) ? candidate : best,
    );
    accepted.push({ route: active, candidate: middle });
  }

  for (const route of prepared) {
    if (route.index === activeRouteIndex) continue;
    let best: Candidate | null = null;
    let bestScore = -1;
    for (const candidate of route.candidates) {
      if (
        accepted.some((entry) =>
          overlaps(candidate, route.width, entry.candidate, entry.route.width),
        )
      )
        continue;
      const separation = Math.min(
        ...accepted.map((entry) => distanceToRoute(candidate.point, entry.route)),
      );
      if (separation < 32) continue;
      const score = separation - 0.01 * Math.abs(candidate.progress - 0.5);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    if (best) accepted.push({ route, candidate: best });
  }
  return accepted.map(({ route, candidate }) => ({
    routeIndex: route.index,
    coordinate: candidate.coordinate,
  }));
}
