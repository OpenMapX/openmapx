import type { RoadConditionEvent } from "./types.js";

const CLUSTER_METERS = 60;
/** Upper bound on vertices compared per geometry, so a long line/polygon can't
 * blow up the O(n²) cluster scan. Vertices beyond this are evenly downsampled. */
const VERTEX_SAMPLE = 24;
const RAW_VERTEX_CAP = 512;
const M_PER_DEG = 111_320;

/** Every [lon,lat] vertex of a geometry, evenly downsampled to {@link VERTEX_SAMPLE}.
 * Sampling across the whole geometry (not just the first vertices) keeps a long
 * line represented end to end. */
function positions(geometry: RoadConditionEvent["geometry"]): [number, number][] {
  const raw: [number, number][] = [];
  const walk = (c: unknown): void => {
    if (raw.length >= RAW_VERTEX_CAP || !Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      raw.push([c[0], c[1]]);
      return;
    }
    for (const x of c) {
      if (raw.length >= RAW_VERTEX_CAP) break;
      walk(x);
    }
  };
  const g = geometry as { coordinates?: unknown; geometries?: unknown[] };
  if (Array.isArray(g.geometries)) {
    for (const sub of g.geometries) walk((sub as { coordinates?: unknown }).coordinates);
  } else {
    walk(g.coordinates);
  }
  if (raw.length <= VERTEX_SAMPLE) return raw;
  const stride = raw.length / VERTEX_SAMPLE;
  const out: [number, number][] = [];
  for (let i = 0; i < VERTEX_SAMPLE; i++) out.push(raw[Math.floor(i * stride)]!);
  return out;
}

/** Project [lon,lat] to local equirectangular metres about a reference latitude —
 * accurate to well under a metre over the ~60 m clustering scale. */
function toLocal(p: [number, number], cosRefLat: number): [number, number] {
  return [p[0] * M_PER_DEG * cosRefLat, p[1] * M_PER_DEG];
}

/** Distance from point `p` to segment `a`–`b` (a point if a===b), in metres. */
function pointToSegmentMeters(
  p: [number, number],
  a: [number, number],
  b: [number, number],
  cosRefLat: number,
): number {
  const [px, py] = toLocal(p, cosRefLat);
  const [ax, ay] = toLocal(a, cosRefLat);
  const [bx, by] = toLocal(b, cosRefLat);
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Nearest distance from point `p` to a polyline (its single vertex if a point). */
function pointToPolylineMeters(
  p: [number, number],
  verts: [number, number][],
  cosRefLat: number,
): number {
  if (verts.length === 1) return pointToSegmentMeters(p, verts[0]!, verts[0]!, cosRefLat);
  let min = Infinity;
  for (let i = 0; i < verts.length - 1; i++) {
    const d = pointToSegmentMeters(p, verts[i]!, verts[i + 1]!, cosRefLat);
    if (d < min) min = d;
  }
  return min;
}

/**
 * Minimum distance between two geometries' vertex sets, measured vertex-to-segment
 * BOTH ways — so a Point near a LineString, or two sparsely digitised overlapping
 * lines (whose vertices need never coincide), still register as co-located.
 */
function geometryDistanceMeters(a: [number, number][], b: [number, number][]): number {
  if (a.length === 0 || b.length === 0) return Infinity;
  const cosRefLat = Math.cos((((a[0]![1] + b[0]![1]) / 2) * Math.PI) / 180);
  let min = Infinity;
  for (const p of a) {
    const d = pointToPolylineMeters(p, b, cosRefLat);
    if (d < min) min = d;
  }
  for (const p of b) {
    const d = pointToPolylineMeters(p, a, cosRefLat);
    if (d < min) min = d;
  }
  return min;
}

function words(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

function headlineSimilar(a: string, b: string): boolean {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return false;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  const union = wa.size + wb.size - inter;
  return union > 0 && inter / union >= 0.5;
}

function newer(a: RoadConditionEvent, b: RoadConditionEvent): RoadConditionEvent {
  const ta = a.dataUpdatedAt ? Date.parse(a.dataUpdatedAt) : 0;
  const tb = b.dataUpdatedAt ? Date.parse(b.dataUpdatedAt) : 0;
  return tb > ta ? b : a;
}

/**
 * Merges duplicate road-condition events across providers. First collapses exact
 * `id` matches, then clusters same-`type` events whose geometries come within
 * {@link CLUSTER_METERS} (minimum vertex-to-segment distance, so a Point and a
 * LineString — or two overlapping lines — for the same incident match) and whose
 * headlines are similar (so NDW and TomTom reporting the same accident become
 * one). The newest `dataUpdatedAt` survives, keeping its own provider/source.
 *
 * Greedy single-linkage: each event merges into the first matching survivor.
 * O(n²·k²) over a bbox query's events (k = {@link VERTEX_SAMPLE}); fine for the
 * few hundred a viewport yields, the vast majority of them points.
 */
export function dedupeRoadConditionEvents(events: RoadConditionEvent[]): RoadConditionEvent[] {
  if (events.length === 0) return [];

  const byId = new Map<string, RoadConditionEvent>();
  for (const e of events) {
    const prev = byId.get(e.id);
    byId.set(e.id, prev ? newer(prev, e) : e);
  }
  const unique = [...byId.values()];

  const survivors: RoadConditionEvent[] = [];
  const survivorPos: [number, number][][] = [];
  for (const e of unique) {
    const ep = positions(e.geometry);
    const dupIdx = survivors.findIndex((s, i) => {
      if (s.type !== e.type) return false;
      const sp = survivorPos[i]!;
      if (ep.length === 0 || sp.length === 0) return false;
      if (geometryDistanceMeters(ep, sp) > CLUSTER_METERS) return false;
      return headlineSimilar(s.headline, e.headline);
    });
    if (dupIdx === -1) {
      survivors.push(e);
      survivorPos.push(ep);
    } else {
      const survivor = newer(survivors[dupIdx]!, e);
      // Keep the surviving event's own geometry as the cluster's representative.
      if (survivor === e) survivorPos[dupIdx] = ep;
      survivors[dupIdx] = survivor;
    }
  }
  return survivors;
}
