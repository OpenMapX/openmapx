#!/usr/bin/env node
/**
 * Generates integrations/map-details/web/derive/driving-side-regions.ts: the
 * left-hand-traffic regions the 3D view's street paint uses to mirror two-way
 * lane layouts.
 *
 * Source: Natural Earth admin-0 countries at 1:50m (public domain),
 * https://github.com/nvkelso/natural-earth-vector, tag v5.1.2,
 * geojson/ne_50m_admin_0_countries.geojson. Hong Kong, Macau, Singapore and
 * Malta are their own admin-0 units there; Gibraltar drives on the right like
 * the surrounding Spain, so it needs no entry.
 *
 * Each country is simplified (Douglas–Peucker relative to its size), small
 * islands are dropped except each country's largest polygon, and coordinates
 * are rounded to 0.01° and encoded as polylines, until the result fits in 12 KB.
 * Coastline vertices then move outward by the simplification tolerance plus a
 * margin, so coastal cities and harbours stay inside (water has no roads);
 * vertices on a border with a right-hand-traffic country stay where they are.
 *
 * Usage: node scripts/map-details/generate-driving-side.mjs [path-to-geojson]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_50m_admin_0_countries.geojson";
const OUTPUT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../integrations/map-details/web/derive/driving-side-regions.ts",
);
const MAX_BYTES = 12 * 1024;
/** Extra outward push for coastline vertices, in degrees. */
const COAST_MARGIN = 0.08;
/** A vertex this close to a right-hand-traffic country is on a land border. */
const BORDER_DISTANCE = 0.03;

/** Natural Earth ADM0_A3 codes of left-hand-traffic countries and territories. */
const LEFT_HAND = new Set([
  // Europe
  "GBR",
  "IRL",
  "IMN",
  "JEY",
  "GGY",
  "MLT",
  "CYP",
  "CYN",
  // Asia
  "IND",
  "PAK",
  "BGD",
  "LKA",
  "NPL",
  "BTN",
  "MDV",
  "THA",
  "MYS",
  "SGP",
  "BRN",
  "IDN",
  "TLS",
  "JPN",
  "HKG",
  "MAC",
  // Oceania
  "AUS",
  "NZL",
  "PNG",
  "FJI",
  "SLB",
  "TON",
  "WSM",
  "KIR",
  "NRU",
  "TUV",
  "COK",
  "NIU",
  "NFK",
  "PCN",
  // Africa
  "ZAF",
  "LSO",
  "SWZ",
  "BWA",
  "NAM",
  "ZWE",
  "ZMB",
  "MWI",
  "MOZ",
  "TZA",
  "KEN",
  "UGA",
  "MUS",
  "SYC",
  "SHN",
  // Americas
  "JAM",
  "BHS",
  "BRB",
  "TTO",
  "GUY",
  "SUR",
  "ATG",
  "DMA",
  "GRD",
  "KNA",
  "LCA",
  "VCT",
  "VGB",
  "VIR",
  "AIA",
  "BMU",
  "CYM",
  "MSR",
  "TCA",
  "FLK",
]);

async function readSource() {
  const path = process.argv[2];
  if (path) return JSON.parse(readFileSync(path, "utf8"));
  const response = await fetch(SOURCE_URL);
  if (!response.ok) throw new Error(`Natural Earth download failed: ${response.status}`);
  return response.json();
}

function bboxDiagonal(ring) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return Math.hypot(maxX - minX, maxY - minY);
}

function perpendicular(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / length;
}

function douglasPeucker(points, tolerance) {
  if (points.length < 3) return points;
  let worst = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicular(points[i], points[0], points[points.length - 1]);
    if (d > worst) {
      worst = d;
      index = i;
    }
  }
  if (worst <= tolerance) return [points[0], points[points.length - 1]];
  const left = douglasPeucker(points.slice(0, index + 1), tolerance);
  const right = douglasPeucker(points.slice(index), tolerance);
  return [...left.slice(0, -1), ...right];
}

function segmentDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq === 0
      ? 0
      : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq));
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
}

/** Edges of every right-hand-traffic country, bucketed by 1° cell. */
function borderIndex(features) {
  const cells = new Map();
  for (const feature of features) {
    if (LEFT_HAND.has(feature.properties.ADM0_A3)) continue;
    const polygons =
      feature.geometry.type === "Polygon"
        ? [feature.geometry.coordinates]
        : feature.geometry.coordinates;
    for (const polygon of polygons) {
      const ring = polygon[0];
      for (let i = 1; i < ring.length; i++) {
        const a = ring[i - 1];
        const b = ring[i];
        for (
          let cx = Math.floor(Math.min(a[0], b[0]));
          cx <= Math.floor(Math.max(a[0], b[0]));
          cx++
        )
          for (
            let cy = Math.floor(Math.min(a[1], b[1]));
            cy <= Math.floor(Math.max(a[1], b[1]));
            cy++
          ) {
            const key = `${cx},${cy}`;
            if (!cells.has(key)) cells.set(key, []);
            cells.get(key).push([a, b]);
          }
      }
    }
  }
  return (p) => {
    for (
      let cx = Math.floor(p[0] - BORDER_DISTANCE);
      cx <= Math.floor(p[0] + BORDER_DISTANCE);
      cx++
    )
      for (
        let cy = Math.floor(p[1] - BORDER_DISTANCE);
        cy <= Math.floor(p[1] + BORDER_DISTANCE);
        cy++
      )
        for (const [a, b] of cells.get(`${cx},${cy}`) ?? [])
          if (segmentDistance(p, a, b) < BORDER_DISTANCE) return true;
    return false;
  };
}

/** Move coastline vertices outward along the vertex bisector; land-border vertices stay. */
function pushCoast(points, distance, onBorder) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const sign = area > 0 ? 1 : -1;
  const normal = (a, b) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy) || 1;
    return [(sign * dy) / length, (-sign * dx) / length];
  };
  return points.map((p, i) => {
    if (onBorder(p)) return p;
    const before = normal(points[(i + points.length - 1) % points.length], p);
    const after = normal(p, points[(i + 1) % points.length]);
    const mx = before[0] + after[0];
    const my = before[1] + after[1];
    const length = Math.hypot(mx, my);
    if (length < 1e-9) return p;
    const scale = Math.min(2, 1 / Math.max((mx * before[0] + my * before[1]) / length, 1e-9));
    return [p[0] + (mx / length) * distance * scale, p[1] + (my / length) * distance * scale];
  });
}

function simplifyRing(ring, relative, maxTolerance, onBorder) {
  const tolerance = Math.min(maxTolerance, Math.max(0.005, relative * bboxDiagonal(ring)));
  // Split the closed ring in two halves so Douglas–Peucker keeps a far point.
  const open = ring.slice(0, -1);
  const half = Math.floor(open.length / 2);
  const first = douglasPeucker(open.slice(0, half + 1), tolerance);
  const second = douglasPeucker([...open.slice(half), open[0]], tolerance);
  const simplified = pushCoast(
    [...first.slice(0, -1), ...second.slice(0, -1)],
    tolerance + COAST_MARGIN,
    onBorder,
  );
  const rounded = [];
  for (const [x, y] of simplified) {
    const point = [Math.round(x * 100), Math.round(y * 100)];
    const last = rounded[rounded.length - 1];
    if (!last || last[0] !== point[0] || last[1] !== point[1]) rounded.push(point);
  }
  return rounded.length >= 3 ? encodeRing(rounded) : null;
}

/** Google's encoded-polyline algorithm over [lng, lat] in hundredths of a degree. */
function encodeRing(points) {
  let out = "";
  let lastX = 0;
  let lastY = 0;
  for (const [x, y] of points) {
    for (const delta of [x - lastX, y - lastY]) {
      let value = delta < 0 ? ~(delta << 1) : delta << 1;
      while (value >= 0x20) {
        out += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
        value >>= 5;
      }
      out += String.fromCharCode(value + 63);
    }
    lastX = x;
    lastY = y;
  }
  return out;
}

function build(features, relative, maxTolerance, minDiagonal, onBorder) {
  const regions = [];
  for (const feature of features) {
    const code = feature.properties.ADM0_A3;
    if (!LEFT_HAND.has(code)) continue;
    const polygons =
      feature.geometry.type === "Polygon"
        ? [feature.geometry.coordinates]
        : feature.geometry.coordinates;
    const outers = polygons.map((polygon) => polygon[0]);
    const largest = outers.reduce((a, b) => (bboxDiagonal(b) > bboxDiagonal(a) ? b : a));
    for (const outer of outers) {
      if (outer !== largest && bboxDiagonal(outer) < minDiagonal) continue;
      const ring = simplifyRing(outer, relative, maxTolerance, onBorder);
      if (ring) regions.push(ring);
    }
  }
  return regions;
}

const source = await readSource();
const onBorder = borderIndex(source.features);
let result = null;
for (const [relative, maxTolerance, minDiagonal] of [
  [0.005, 0.02, 0.1],
  [0.0075, 0.03, 0.2],
  [0.01, 0.05, 0.3],
  [0.015, 0.1, 0.5],
  [0.02, 0.15, 1],
  [0.03, 0.2, 1.5],
  [0.04, 0.3, 2],
  [0.05, 0.4, 3],
  [0.06, 0.5, 4],
]) {
  const regions = build(source.features, relative, maxTolerance, minDiagonal, onBorder);
  if (JSON.stringify(regions).length <= MAX_BYTES) {
    result = regions;
    console.log(`relative ${relative}, max tolerance ${maxTolerance}°, min island ${minDiagonal}°`);
    break;
  }
}
if (!result) throw new Error("Could not simplify the regions under 12 KB");

writeFileSync(
  OUTPUT,
  `// Generated by scripts/map-details/generate-driving-side.mjs from Natural Earth
// admin-0 countries 1:50m v5.1.2 (public domain). Do not edit by hand.
//
// Left-hand-traffic regions as rings of [lng, lat] in hundredths of a degree,
// each in Google's encoded-polyline format (deltas, 5-bit groups + 63).
export const LEFT_HAND_TRAFFIC_REGIONS: readonly string[] = ${JSON.stringify(result)};
`,
);
console.log(`${result.length} rings, ${JSON.stringify(result).length} bytes`);
