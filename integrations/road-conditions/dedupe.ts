import { hasRestrictionEvidence } from "./effects.js";
import type { LocalizedText, RoadConditionEvent } from "./types.js";

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
  for (let i = 0; i < VERTEX_SAMPLE; i++) out.push(raw[Math.floor(i * stride)]);
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
  if (verts.length === 1) return pointToSegmentMeters(p, verts[0], verts[0], cosRefLat);
  let min = Infinity;
  for (let i = 0; i < verts.length - 1; i++) {
    const d = pointToSegmentMeters(p, verts[i], verts[i + 1], cosRefLat);
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
  const cosRefLat = Math.cos((((a[0][1] + b[0][1]) / 2) * Math.PI) / 180);
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

function textSimilar(a: string, b: string): boolean {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return false;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  const union = wa.size + wb.size - inter;
  return union > 0 && inter / union >= 0.5;
}

/**
 * Whether two headlines say the same: the publishers' own texts, or any two
 * texts in one language. Providers publish in different languages, and a
 * translation never matches the original word for word.
 */
function headlineSimilar(a: LocalizedText | undefined, b: LocalizedText | undefined): boolean {
  const [ownA, ownB] = [a?.[0], b?.[0]];
  if (!a || !b || !ownA || !ownB) return false;
  if (textSimilar(ownA.text, ownB.text)) return true;
  return a.some((ta) =>
    b.some(
      (tb) => ta.lang.toLowerCase() === tb.lang.toLowerCase() && textSimilar(ta.text, tb.text),
    ),
  );
}

const roadKey = (s: string) => s.toLowerCase().replace(/\s+/g, "");

/** Normalised road keys for an event: refs and names in every language. */
function roadKeys(e: RoadConditionEvent): Set<string> {
  const keys = new Set<string>();
  for (const r of e.roads ?? []) {
    if (r.ref) keys.add(roadKey(r.ref));
    for (const name of r.name ?? []) {
      const k = roadKey(name.text);
      if (k) keys.add(k);
    }
  }
  return keys;
}

/**
 * What a situation does, independent of who reported it: its classification,
 * when it holds, where it heads and each effect's rule. Ids, texts and
 * provenance are left out, so two providers' copies of one situation agree.
 */
function semanticKey(e: RoadConditionEvent): string {
  return JSON.stringify([
    e.kind,
    e.type,
    e.subtype ?? null,
    e.validity,
    e.direction?.value ?? null,
    e.effects.map(
      ({ id: _id, sourceRecordRef: _ref, issues: _issues, location: _loc, ...rule }) => rule,
    ),
  ]);
}

/**
 * True when both events name roads and share NONE — i.e. they are on different
 * roads, so they must not merge even if co-located with a similar headline (an
 * interchange where two roads pass within the cluster radius). When either event
 * carries no road ref (e.g. NDW, which omits road names) there is no discriminator
 * and this returns false, preserving the geometry+headline behaviour.
 */
function roadsConflict(a: RoadConditionEvent, b: RoadConditionEvent): boolean {
  const ka = roadKeys(a);
  const kb = roadKeys(b);
  if (ka.size === 0 || kb.size === 0) return false;
  for (const k of ka) if (kb.has(k)) return false;
  return true;
}

function newer(a: RoadConditionEvent, b: RoadConditionEvent): RoadConditionEvent {
  const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0;
  const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0;
  return tb > ta ? b : a;
}

/**
 * Merges duplicate road-condition situations across providers. First collapses
 * exact `id` matches, then clusters situations with the same classification,
 * validity, direction and effect rules whose geometries come within
 * {@link CLUSTER_METERS} (minimum vertex-to-segment distance, so a Point and a
 * LineString — or two overlapping lines — for the same incident match) and whose
 * headlines are similar (so NDW and TomTom reporting the same accident become
 * one). Situations that name different roads never merge (see
 * {@link roadsConflict}), so two incidents passing within the radius at an
 * interchange stay distinct. The newest `updatedAt` survives whole, keeping its
 * own provider, source and attribution; the other copy is dropped.
 *
 * Greedy single-linkage: each situation merges into the first matching
 * survivor. O(n²·k²) over a bbox query's situations (k = {@link VERTEX_SAMPLE});
 * fine for the few hundred a viewport yields, the vast majority of them points.
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
  const survivorKeys: string[] = [];
  for (const e of unique) {
    const ep = positions(e.geometry);
    const key = semanticKey(e);
    const dupIdx = survivors.findIndex((s, i) => {
      // A situation carrying restriction evidence never merges into another.
      // Two sources' partly read rules are two claims and two provenances;
      // dropping one would silently lose what the other did not say.
      if (hasRestrictionEvidence(s) || hasRestrictionEvidence(e)) return false;
      if (survivorKeys[i] !== key) return false;
      const sp = survivorPos[i];
      if (ep.length === 0 || sp.length === 0) return false;
      if (geometryDistanceMeters(ep, sp) > CLUSTER_METERS) return false;
      if (roadsConflict(s, e)) return false;
      return headlineSimilar(s.headline, e.headline) && liesAlong(s.geometry, e.geometry);
    });
    if (dupIdx === -1) {
      survivors.push(e);
      survivorPos.push(ep);
      survivorKeys.push(key);
    } else if (newer(survivors[dupIdx], e) === e) {
      // The newer copy survives whole, with its own geometry as the cluster's.
      survivors[dupIdx] = e;
      survivorPos[dupIdx] = ep;
    }
  }
  return foldAcrossSources(survivors);
}

/**
 * Cross-source folding, from 1,442 candidate pairs of 34 live feeds labelled by
 * hand (2026-10-28): a city's roadworks against the state's or the motorway
 * operator's record of the same works. Two publishers' records of one measure
 * agree on their dates and lie one on top of the other, but share neither the
 * publisher's own type nor, often, the exact validity or wording. Distance is
 * no signal: a street crossing a motorway lies at 0 m. So a record folds into
 * another of a different source when:
 *
 * - their kinds agree, works and closures counting as one;
 * - both state a start and an end, both within a day of the other's, or one
 *   within a day and the other within a month when the headlines also agree;
 * - one lies along the other (at least 80 %, 60 % with agreeing headlines,
 *   of its length within {@link COVER_METERS}) and, unless one is a point,
 *   the smaller covers at least 30 % of the larger: a ramp or a short section
 *   inside a long corridor record of the same works is another element of it.
 *
 * On the labelled pairs this folds 99 of 140 duplicates and 91 of 192 records
 * covering part of another, against 3 of 1,109 pairs describing different
 * measures. The record covering the other survives, so a section folds into
 * the whole; a record with restriction evidence (lanes, dimensions) is never
 * dropped, and two such records never fold.
 */
const COVER_METERS = 15;
const SAME_DAY_H = 25;
const SAME_MONTH_H = 31 * 24;
const SAMPLES = 64;
/** Shorter than this, a geometry is a point: it cannot cover a line. */
const POINT_METERS = 20;

type Part = [number, number][];

/** A geometry's lines, polygon rings and points as [lon,lat] vertex lists. */
function partsOf(geometry: RoadConditionEvent["geometry"]): Part[] {
  const out: Part[] = [];
  const walk = (c: unknown): void => {
    if (!Array.isArray(c) || c.length === 0) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      out.push([[c[0], c[1]]]);
      return;
    }
    const first = c[0] as unknown;
    if (Array.isArray(first) && typeof first[0] === "number") {
      out.push((c as [number, number][]).map(([x, y]) => [x, y]));
      return;
    }
    for (const x of c) walk(x);
  };
  const g = geometry as { coordinates?: unknown; geometries?: { coordinates?: unknown }[] };
  if (Array.isArray(g.geometries)) for (const sub of g.geometries) walk(sub.coordinates);
  else walk(g.coordinates);
  return out;
}

interface Shape {
  parts: Part[];
  bbox: [number, number, number, number];
}

const shapes = new WeakMap<object, Shape | null>();

/** A geometry's parts and bounding box, computed once per geometry object. */
function shapeOf(geometry: RoadConditionEvent["geometry"]): Shape | undefined {
  const cached = shapes.get(geometry);
  if (cached !== undefined) return cached ?? undefined;
  const shape = computeShape(geometry);
  shapes.set(geometry, shape ?? null);
  return shape;
}

function computeShape(geometry: RoadConditionEvent["geometry"]): Shape | undefined {
  const parts = partsOf(geometry);
  if (parts.length === 0) return undefined;
  const bbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const part of parts)
    for (const [x, y] of part) {
      bbox[0] = Math.min(bbox[0], x);
      bbox[1] = Math.min(bbox[1], y);
      bbox[2] = Math.max(bbox[2], x);
      bbox[3] = Math.max(bbox[3], y);
    }
  return { parts, bbox };
}

/** Whether two bounding boxes come within `meters` of each other. */
function bboxesNear(a: Shape["bbox"], b: Shape["bbox"], meters: number): boolean {
  const dLat = meters / M_PER_DEG;
  const dLon = dLat / Math.max(0.1, Math.cos((((a[1] + a[3]) / 2) * Math.PI) / 180));
  return a[0] - dLon <= b[2] && b[0] - dLon <= a[2] && a[1] - dLat <= b[3] && b[1] - dLat <= a[3];
}

function lengthMeters(parts: Part[], cosRefLat: number): number {
  let sum = 0;
  for (const part of parts)
    for (let i = 1; i < part.length; i++) {
      const [ax, ay] = toLocal(part[i - 1], cosRefLat);
      const [bx, by] = toLocal(part[i], cosRefLat);
      sum += Math.hypot(bx - ax, by - ay);
    }
  return sum;
}

/** Points spread evenly along a shape's lines, at most {@link SAMPLES} of them. */
function samplesAlong(parts: Part[], cosRefLat: number): [number, number][] {
  const total = lengthMeters(parts, cosRefLat);
  if (total === 0) return parts.map((part) => part[0]);
  const step = total / SAMPLES;
  const out: [number, number][] = [];
  for (const part of parts) {
    if (part.length === 1) out.push(part[0]);
    for (let i = 1; i < part.length; i++) {
      const [ax, ay] = part[i - 1];
      const [bx, by] = part[i];
      const [lx, ly] = toLocal(part[i - 1], cosRefLat);
      const [mx, my] = toLocal(part[i], cosRefLat);
      const n = Math.max(1, Math.ceil(Math.hypot(mx - lx, my - ly) / step));
      for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
    }
    const last = part[part.length - 1];
    if (part.length > 1) out.push(last);
  }
  return out;
}

/** The share of `a`'s length lying within `meters` (by default {@link COVER_METERS}) of `b`. */
function coverage(a: Part[], b: Part[], cosRefLat: number, meters = COVER_METERS): number {
  const samples = samplesAlong(a, cosRefLat);
  if (samples.length === 0) return 0;
  let near = 0;
  for (const p of samples) {
    let hit = false;
    for (const part of b) {
      hit = pointToPolylineMeters(p, part, cosRefLat) <= meters;
      if (hit) break;
    }
    if (hit) near++;
  }
  return near / samples.length;
}

const hours = (iso: string | undefined): number | undefined => {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms / 3_600_000 : undefined;
};

const WORKS_OR_CLOSURE = new Set(["roadworks", "closure"]);
const kindsAgree = (a: string, b: string) =>
  a === b || (WORKS_OR_CLOSURE.has(a) && WORKS_OR_CLOSURE.has(b));

/**
 * How `b` relates to `a` across sources: undefined when they are not one
 * measure, else which of them survives (the one covering the other).
 */
function crossSourceSurvivor(
  a: RoadConditionEvent,
  sa: Shape,
  b: RoadConditionEvent,
  sb: Shape,
): RoadConditionEvent | undefined {
  if (a.source === b.source || !kindsAgree(a.kind, b.kind)) return undefined;
  const evidenceA = hasRestrictionEvidence(a);
  const evidenceB = hasRestrictionEvidence(b);
  if (evidenceA && evidenceB) return undefined;
  const [startA, endA, startB, endB] = [
    hours(a.validity.start),
    hours(a.validity.end),
    hours(b.validity.start),
    hours(b.validity.end),
  ];
  if (startA === undefined || endA === undefined || startB === undefined || endB === undefined)
    return undefined;
  const dStart = Math.abs(startA - startB);
  const dEnd = Math.abs(endA - endB);
  const sameDays = dStart <= SAME_DAY_H && dEnd <= SAME_DAY_H;
  const oneDay =
    (dStart <= SAME_DAY_H && dEnd <= SAME_MONTH_H) ||
    (dEnd <= SAME_DAY_H && dStart <= SAME_MONTH_H);
  const headlines = !sameDays && oneDay && headlineSimilar(a.headline, b.headline);
  if (!sameDays && !headlines) return undefined;
  if (!bboxesNear(sa.bbox, sb.bbox, COVER_METERS)) return undefined;
  const cosRefLat = Math.cos((((sa.bbox[1] + sa.bbox[3]) / 2) * Math.PI) / 180);
  const aInB = coverage(sa.parts, sb.parts, cosRefLat);
  const bInA = coverage(sb.parts, sa.parts, cosRefLat);
  const point =
    lengthMeters(sa.parts, cosRefLat) < POINT_METERS ||
    lengthMeters(sb.parts, cosRefLat) < POINT_METERS;
  const along = sameDays ? 0.8 : 0.6;
  if (Math.max(aInB, bInA) < along) return undefined;
  if (!point && Math.min(aInB, bInA) < 0.3) return undefined;
  // A point near a line or another point may be on a crossing road.
  if (point && roadsConflict(a, b)) return undefined;
  if (evidenceA) return a;
  if (evidenceB) return b;
  if (aInB !== bInA) return aInB > bInA ? b : a;
  return newer(a, b);
}

/** Grid cells, about a kilometre across, that a bounding box grown by {@link COVER_METERS} touches. */
const CELL_DEG = 0.01;
function cellsOf(bbox: Shape["bbox"]): string[] {
  const grow = (2 * COVER_METERS) / M_PER_DEG;
  const out: string[] = [];
  for (
    let x = Math.floor((bbox[0] - grow) / CELL_DEG);
    x <= Math.floor((bbox[2] + grow) / CELL_DEG);
    x++
  )
    for (
      let y = Math.floor((bbox[1] - grow) / CELL_DEG);
      y <= Math.floor((bbox[3] + grow) / CELL_DEG);
      y++
    )
      out.push(`${x}:${y}`);
  return out;
}

/** Folds each record into an earlier one of another source describing the same measure. */
function foldAcrossSources(events: RoadConditionEvent[]): RoadConditionEvent[] {
  type Kept = { event: RoadConditionEvent; shape: Shape | undefined; order: number };
  const kept: Kept[] = [];
  const grid = new Map<string, Kept[]>();
  const index = (k: Kept) => {
    if (!k.shape) return;
    for (const cell of cellsOf(k.shape.bbox)) {
      const list = grid.get(cell);
      if (!list) grid.set(cell, [k]);
      else if (!list.includes(k)) list.push(k);
    }
  };
  for (const event of events) {
    const shape = shapeOf(event.geometry);
    let folded = false;
    if (shape) {
      const seen = new Set<Kept>();
      const near = cellsOf(shape.bbox)
        .flatMap((cell) => grid.get(cell) ?? [])
        .filter((k) => !seen.has(k) && seen.add(k))
        .sort((a, b) => a.order - b.order);
      for (const k of near) {
        if (!k.shape) continue;
        const survivor = crossSourceSurvivor(k.event, k.shape, event, shape);
        if (!survivor) continue;
        if (survivor === event) {
          k.event = event;
          k.shape = shape;
          index(k);
        }
        folded = true;
        break;
      }
    }
    if (folded) continue;
    const entry: Kept = { event, shape, order: kept.length };
    kept.push(entry);
    index(entry);
  }
  return kept.map((k) => k.event);
}

/** Within this, two copies of one line digitised by different providers lie along each other. */
const COPY_ALONG_METERS = 30;

/**
 * Whether one of two lines lies along the other, at least half of it within
 * {@link COPY_ALONG_METERS}; a point always does. Vertex distance alone lets
 * two sections that merely meet at a junction pass as one.
 */
function liesAlong(a: RoadConditionEvent["geometry"], b: RoadConditionEvent["geometry"]): boolean {
  const sa = shapeOf(a);
  const sb = shapeOf(b);
  if (!sa || !sb) return true;
  const cosRefLat = Math.cos((((sa.bbox[1] + sa.bbox[3]) / 2) * Math.PI) / 180);
  if (
    lengthMeters(sa.parts, cosRefLat) < POINT_METERS ||
    lengthMeters(sb.parts, cosRefLat) < POINT_METERS
  )
    return true;
  return (
    Math.max(
      coverage(sa.parts, sb.parts, cosRefLat, COPY_ALONG_METERS),
      coverage(sb.parts, sa.parts, cosRefLat, COPY_ALONG_METERS),
    ) >= 0.5
  );
}
