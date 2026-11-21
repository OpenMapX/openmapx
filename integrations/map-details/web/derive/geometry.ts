/**
 * Plane geometry for derived street paint. Coordinates are metres in the tile
 * frame: x east, y south (tile units scaled by metres per unit). "Right of
 * travel" for a direction (dx, dy) is therefore (−dy, dx). Rings are open
 * (the first point is not repeated) and every output ring is an independent
 * outer ring; the encoder fixes the winding.
 */

export type Pt = [number, number];
export type Ring = Pt[];

const EPSILON = 1e-9;
const FAN_STEP_RAD = Math.PI / 6;
const MITRE_LIMIT = 2;

function dedupe(line: readonly Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of line) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > EPSILON || Math.abs(last[1] - p[1]) > EPSILON)
      out.push([p[0], p[1]]);
  }
  return out;
}

function direction(a: Pt, b: Pt): Pt {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  return [dx / length, dy / length];
}

/** Unit normal to the right of travel. */
function rightNormal(d: Pt): Pt {
  return [-d[1], d[0]];
}

/** Signed area by the shoelace formula; positive for rings clockwise on screen (y south). */
export function ringArea(ring: readonly Pt[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Pt;
    const b = ring[(i + 1) % ring.length] as Pt;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

export function polylineLength(line: readonly Pt[]): number {
  let length = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1] as Pt;
    const b = line[i] as Pt;
    length += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return length;
}

/**
 * The line widened by `halfWidth` on both sides: one quad per segment, flat
 * caps, and a fan on the outer side of each interior vertex.
 */
export function bufferPolyline(line: readonly Pt[], halfWidth: number): Ring[] {
  const points = dedupe(line);
  const rings: Ring[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Pt;
    const b = points[i] as Pt;
    const [nx, ny] = rightNormal(direction(a, b));
    const ox = nx * halfWidth;
    const oy = ny * halfWidth;
    rings.push([
      [a[0] + ox, a[1] + oy],
      [b[0] + ox, b[1] + oy],
      [b[0] - ox, b[1] - oy],
      [a[0] - ox, a[1] - oy],
    ]);
  }
  for (let i = 1; i < points.length - 1; i++) {
    const v = points[i] as Pt;
    const d1 = direction(points[i - 1] as Pt, v);
    const d2 = direction(v, points[i + 1] as Pt);
    const turn = d1[0] * d2[1] - d1[1] * d2[0];
    if (Math.abs(turn) < EPSILON && d1[0] * d2[0] + d1[1] * d2[1] > 0) continue;
    // A right turn (positive on screen) opens the left side, and vice versa.
    const side = turn > 0 ? -1 : 1;
    const n1 = rightNormal(d1);
    const n2 = rightNormal(d2);
    let a1 = Math.atan2(n1[1] * side, n1[0] * side);
    const a2 = Math.atan2(n2[1] * side, n2[0] * side);
    let sweep = a2 - a1;
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    while (sweep < -Math.PI) sweep += 2 * Math.PI;
    const steps = Math.max(1, Math.ceil(Math.abs(sweep) / FAN_STEP_RAD));
    const fan: Ring = [[v[0], v[1]]];
    for (let s = 0; s <= steps; s++) {
      fan.push([v[0] + Math.cos(a1) * halfWidth, v[1] + Math.sin(a1) * halfWidth]);
      a1 += sweep / steps;
    }
    rings.push(fan);
  }
  return rings;
}

/** The line moved `offset` metres to the right of travel (left when negative), mitred up to 2×. */
export function offsetPolyline(line: readonly Pt[], offset: number): Pt[] {
  const points = dedupe(line);
  if (points.length < 2) return points;
  const out: Pt[] = [];
  for (let i = 0; i < points.length; i++) {
    const v = points[i] as Pt;
    const before = i > 0 ? rightNormal(direction(points[i - 1] as Pt, v)) : null;
    const after = i < points.length - 1 ? rightNormal(direction(v, points[i + 1] as Pt)) : null;
    const n1 = before ?? (after as Pt);
    const n2 = after ?? (before as Pt);
    let mx = n1[0] + n2[0];
    let my = n1[1] + n2[1];
    const length = Math.hypot(mx, my);
    let scale = 1;
    if (length < EPSILON) {
      mx = n1[0];
      my = n1[1];
    } else {
      mx /= length;
      my /= length;
      scale = Math.min(MITRE_LIMIT, 1 / Math.max(mx * n1[0] + my * n1[1], EPSILON));
    }
    out.push([v[0] + mx * offset * scale, v[1] + my * offset * scale]);
  }
  return out;
}

/** The part of a polyline between two distances along it. */
export function slice(line: readonly Pt[], fromM: number, toM: number): Pt[] {
  const out: Pt[] = [];
  if (toM <= fromM) return out;
  let walked = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1] as Pt;
    const b = line[i] as Pt;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < EPSILON) continue;
    const ux = (b[0] - a[0]) / length;
    const uy = (b[1] - a[1]) / length;
    const start = walked;
    const end = walked + length;
    walked = end;
    if (end < fromM || start > toM) continue;
    if (out.length === 0) {
      const t = Math.max(fromM, start) - start;
      out.push([a[0] + ux * t, a[1] + uy * t]);
    }
    if (end <= toM) {
      if (end > fromM) out.push([b[0], b[1]]);
    } else {
      const t = toM - start;
      out.push([a[0] + ux * t, a[1] + uy * t]);
      break;
    }
  }
  return out.length >= 2 ? out : [];
}

/** Dash pieces along a line, restarting the phase at its start. */
export function dashes(line: readonly Pt[], dash: number, gap: number): Pt[][] {
  const total = polylineLength(line);
  const pieces: Pt[][] = [];
  for (let start = 0; start < total - EPSILON; start += dash + gap) {
    const piece = slice(line, start, Math.min(start + dash, total));
    if (piece.length >= 2) pieces.push(piece);
  }
  return pieces;
}

function clipEdge(ring: Ring, inside: (p: Pt) => boolean, cross: (a: Pt, b: Pt) => Pt): Ring {
  const out: Ring = [];
  for (let i = 0; i < ring.length; i++) {
    const current = ring[i] as Pt;
    const previous = ring[(i + ring.length - 1) % ring.length] as Pt;
    const inCurrent = inside(current);
    if (inCurrent !== inside(previous)) out.push(cross(previous, current));
    if (inCurrent) out.push(current);
  }
  return out;
}

/** Sutherland–Hodgman clip of each ring to the square [min, max]²; empty rings are dropped. */
export function clipRingsToSquare(rings: readonly Ring[], min: number, max: number): Ring[] {
  const atX =
    (x: number) =>
    (a: Pt, b: Pt): Pt => [x, a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0])];
  const atY =
    (y: number) =>
    (a: Pt, b: Pt): Pt => [a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]), y];
  const out: Ring[] = [];
  for (const ring of rings) {
    let clipped: Ring = ring;
    clipped = clipEdge(clipped, (p) => p[0] >= min, atX(min));
    clipped = clipEdge(clipped, (p) => p[0] <= max, atX(max));
    clipped = clipEdge(clipped, (p) => p[1] >= min, atY(min));
    clipped = clipEdge(clipped, (p) => p[1] <= max, atY(max));
    if (clipped.length >= 3 && Math.abs(ringArea(clipped)) > EPSILON) out.push(clipped);
  }
  return out;
}

function inRing(p: Pt, ring: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as Pt;
    const b = ring[j] as Pt;
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

export function pointInPolygon(
  p: Pt,
  outer: readonly Pt[],
  holes: readonly (readonly Pt[])[],
): boolean {
  return inRing(p, outer) && !holes.some((hole) => inRing(p, hole));
}

/** Distance from a point to a polyline, with the nearest segment and the position along it (0..1). */
export function distanceToPolyline(
  p: Pt,
  line: readonly Pt[],
): { d: number; segment: number; t: number } {
  let best = { d: Number.POSITIVE_INFINITY, segment: -1, t: 0 };
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1] as Pt;
    const b = line[i] as Pt;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSq = dx * dx + dy * dy;
    const t =
      lengthSq < EPSILON
        ? 0
        : Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq));
    const d = Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
    if (d < best.d) best = { d, segment: i - 1, t };
  }
  return best;
}

/** Convex hull (Andrew's monotone chain), as an open ring. */
export function convexHull(points: readonly Pt[]): Ring {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return sorted.map((p) => [p[0], p[1]]);
  const cross = (o: Pt, a: Pt, b: Pt) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const p of sorted) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2] as Pt, lower[lower.length - 1] as Pt, p) <= 0
    )
      lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i] as Pt;
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2] as Pt, upper[upper.length - 1] as Pt, p) <= 0
    )
      upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)].map((p) => [p[0], p[1]]);
}

/** Minimum-area enclosing rectangle of a convex hull (rotating calipers); `axis` runs along the long side. */
export function minAreaRect(hull: readonly Pt[]): {
  centre: Pt;
  axis: Pt;
  length: number;
  width: number;
} {
  let best = {
    area: Number.POSITIVE_INFINITY,
    centre: [0, 0] as Pt,
    axis: [1, 0] as Pt,
    length: 0,
    width: 0,
  };
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i] as Pt;
    const b = hull[(i + 1) % hull.length] as Pt;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < EPSILON) continue;
    const u: Pt = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    const v: Pt = [-u[1], u[0]];
    let minU = Number.POSITIVE_INFINITY;
    let maxU = Number.NEGATIVE_INFINITY;
    let minV = Number.POSITIVE_INFINITY;
    let maxV = Number.NEGATIVE_INFINITY;
    for (const p of hull) {
      const pu = p[0] * u[0] + p[1] * u[1];
      const pv = p[0] * v[0] + p[1] * v[1];
      minU = Math.min(minU, pu);
      maxU = Math.max(maxU, pu);
      minV = Math.min(minV, pv);
      maxV = Math.max(maxV, pv);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < best.area) {
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      const centre: Pt = [u[0] * cu + v[0] * cv, u[1] * cu + v[1] * cv];
      const alongU = maxU - minU >= maxV - minV;
      best = {
        area,
        centre,
        axis: alongU ? u : v,
        length: Math.max(maxU - minU, maxV - minV),
        width: Math.min(maxU - minU, maxV - minV),
      };
    }
  }
  return { centre: best.centre, axis: best.axis, length: best.length, width: best.width };
}

/** Place template rings (metres, centred, long axis +y) at `centre` with +y along `axis`. */
export function transformTemplate(
  rings: readonly Ring[],
  centre: Pt,
  axis: Pt,
  scale: number,
): Ring[] {
  const across: Pt = [-axis[1], axis[0]];
  return rings.map((ring) =>
    ring.map(([u, v]) => [
      centre[0] + (axis[0] * v + across[0] * u) * scale,
      centre[1] + (axis[1] * v + across[1] * u) * scale,
    ]),
  );
}
