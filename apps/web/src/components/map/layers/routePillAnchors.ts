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
  for (const [p, q] of [
    [-dx, a.x - rect.left],
    [dx, rect.right - a.x],
    [-dy, a.y - rect.top],
    [dy, rect.bottom - a.y],
  ]) {
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

function distanceToSegments(point: Point, segments: Segment[]): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const { a, b } of segments) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared <= 0) continue;
    const t = Math.max(
      0,
      Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared),
    );
    nearest = Math.min(nearest, Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t)));
  }
  return nearest;
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
    for (let i = 1; i < route.geometry.length; i++) {
      const from = route.geometry[i - 1];
      const to = route.geometry[i];
      if (![...from, ...to].every(Number.isFinite)) continue;
      const a = project(from);
      const b = project(to);
      if (![a.x, a.y, b.x, b.y].every(Number.isFinite) || distance(a, b) < 0.01) continue;
      const segment = { from, to, a, b };
      segments.push(segment);
      const clipped = clipSegment(a, b, rect);
      if (clipped && clipped.end > clipped.start) {
        visible.push({
          ...clipped,
          segment,
          length: distance(a, b) * (clipped.end - clipped.start),
        });
      }
    }
    const total = visible.reduce((sum, part) => sum + part.length, 0);
    if (total < 1) continue;
    const candidates: Candidate[] = [];
    for (let step = 1; step <= 39; step++) {
      const progress = step / 40;
      let remaining = progress * total;
      for (const part of visible) {
        if (remaining > part.length) {
          remaining -= part.length;
          continue;
        }
        const t = part.start + (remaining / part.length) * (part.end - part.start);
        const coordinate = interpolate(part.segment.from, part.segment.to, t);
        candidates.push({ coordinate, point: project(coordinate), progress });
        break;
      }
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

  const activeSegments = active?.segments ?? [];
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
      const otherLines = [
        activeSegments,
        ...accepted
          .filter((entry) => entry.route.index !== activeRouteIndex)
          .map((entry) => entry.route.segments),
      ];
      const separation = Math.min(
        ...otherLines
          .filter((line) => line.length > 0)
          .map((line) => distanceToSegments(candidate.point, line)),
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
