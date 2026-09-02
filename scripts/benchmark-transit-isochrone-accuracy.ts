#!/usr/bin/env -S pnpm exec tsx

/**
 * Compare sampled isochrone polygons against exact MOTIS point checks.
 *
 * Near the contour boundary the two legitimately disagree: the polygon
 * interpolates between lattice points, so a location within about a cell of the
 * edge can fall on either side. Those cases are reported, not gated. Beyond two
 * cells there is no sampling excuse, and disagreement means the pipeline is
 * wrong — that is what makes the run exit non-zero.
 */

export interface SamplePoint {
  id: string;
  lng: number;
  lat: number;
}

export interface SampleClassification {
  id: string;
  insidePolygon: boolean;
  exactReachable: boolean;
  /** Distance from the contour boundary, in lattice cells. */
  cellsFromBoundary: number;
}

/**
 * Beyond this distance from the boundary, sampling resolution can no longer
 * explain a disagreement.
 */
const INVARIANT_CELLS = 2;

function inRing(point: SamplePoint, ring: number[][]): boolean {
  let contained = false;
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > point.lat !== yj > point.lat &&
      point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi
    ) {
      contained = !contained;
    }
  }
  return contained;
}

/** A point is inside when it is in an exterior ring and in none of that ring's holes. */
export function classifySamplePoints(
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon,
  points: readonly SamplePoint[],
): Array<SamplePoint & { insidePolygon: boolean }> {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return points.map((point) => ({
    ...point,
    insidePolygon: polygons.some(
      ([exterior, ...holes]) =>
        inRing(point, exterior) && !holes.some((hole) => inRing(point, hole)),
    ),
  }));
}

export interface AccuracySummary {
  falseInside: number;
  falseOutside: number;
  nearBoundary: number;
  invariantFailures: number;
  total: number;
}

export function summariseAccuracy(results: readonly SampleClassification[]): AccuracySummary {
  let falseInside = 0;
  let falseOutside = 0;
  let nearBoundary = 0;
  let invariantFailures = 0;
  for (const result of results) {
    const disagrees = result.insidePolygon !== result.exactReachable;
    if (result.cellsFromBoundary <= INVARIANT_CELLS) {
      if (disagrees) nearBoundary += 1;
      continue;
    }
    if (!disagrees) continue;
    if (result.insidePolygon) falseInside += 1;
    else falseOutside += 1;
    invariantFailures += 1;
  }
  return { falseInside, falseOutside, nearBoundary, invariantFailures, total: results.length };
}

/** Shortest distance from a point to any ring edge, in degrees. */
export function distanceToBoundaryDegrees(
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon,
  point: SamplePoint,
): number {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let best = Number.POSITIVE_INFINITY;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (let i = 0; i < ring.length - 1; i += 1) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[i + 1];
        const dx = x2 - x1;
        const dy = y2 - y1;
        const lengthSquared = dx * dx + dy * dy;
        const t =
          lengthSquared === 0
            ? 0
            : Math.max(
                0,
                Math.min(1, ((point.lng - x1) * dx + (point.lat - y1) * dy) / lengthSquared),
              );
        best = Math.min(best, Math.hypot(point.lng - (x1 + t * dx), point.lat - (y1 + t * dy)));
      }
    }
  }
  return best;
}

/** Deterministic pseudo-random sample points across a bbox. */
export function stratifiedSamplePoints(
  bbox: [number, number, number, number],
  count: number,
): SamplePoint[] {
  const [west, south, east, north] = bbox;
  let seed = 0x2f6e2b1;
  const next = () => {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  return Array.from({ length: count }, (_, index) => ({
    id: `sample-${index}`,
    lng: west + next() * (east - west),
    lat: south + next() * (north - south),
  }));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const fail = (message: string): never => {
    console.error(`benchmark-transit-isochrone-accuracy: ${message}`);
    process.exit(1);
  };

  const rawBaseUrl = value("--base-url");
  if (!rawBaseUrl) fail("--base-url is required (the OpenMapX API, not MOTIS)");
  const baseUrl = new URL(rawBaseUrl);
  const host = baseUrl.hostname.replace(/^\[|\]$/g, "");
  const privateTarget =
    host === "localhost" ||
    host === "::1" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    (() => {
      const match = host.match(/^172\.(\d+)\./);
      const second = Number(match?.[1]);
      return match !== null && second >= 16 && second <= 31;
    })();
  if (!privateTarget && !args.includes("--allow-remote")) {
    fail("refusing a non-loopback/non-private target; pass --allow-remote deliberately");
  }

  const lat = Number(value("--lat") ?? "52.525");
  const lng = Number(value("--lng") ?? "13.369");
  const minutes = Number(value("--minutes") ?? "30");
  const span = Number(value("--span") ?? "0.08");
  const samples = Number(value("--samples") ?? "120");
  if (![lat, lng, minutes, span, samples].every(Number.isFinite)) fail("invalid numeric argument");

  const bbox: [number, number, number, number] = [lng - span, lat - span, lng + span, lat + span];
  const departure = new Date();
  departure.setUTCSeconds(0, 0);
  const query = {
    origin: { lng, lat },
    queryTime: departure.toISOString(),
    direction: "depart-at" as const,
    thresholdsMinutes: [minutes],
    walkProfileId: "foot-1.2-cap-900-v1" as const,
  };

  const isochroneResponse = await fetch(
    new URL("/api/integrations/transit/reachability/isochrone", baseUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...query, bbox }),
    },
  );
  if (!isochroneResponse.ok) fail(`isochrone request failed: ${isochroneResponse.status}`);
  const isochrone = (await isochroneResponse.json()) as {
    data: {
      sampling: { bbox: [number, number, number, number]; resolutionMetres: number };
      featureCollection: GeoJSON.FeatureCollection;
    };
  };

  const feature = isochrone.data.featureCollection.features.find(
    (candidate) => candidate.properties?.travelTimeMinutes === minutes,
  );
  if (!feature) fail(`no contour returned for ${minutes} minutes`);
  const geometry = feature.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon;

  const points = stratifiedSamplePoints(isochrone.data.sampling.bbox, samples);
  const classified = classifySamplePoints(geometry, points);

  const checkResponse = await fetch(
    new URL("/api/integrations/transit/reachability/check", baseUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...query, destinations: points.slice(0, 200) }),
    },
  );
  if (!checkResponse.ok) fail(`exact check failed: ${checkResponse.status}`);
  const check = (await checkResponse.json()) as {
    data: { results: Array<{ id: string; reachable: boolean }> };
  };
  const exact = new Map(check.data.results.map((result) => [result.id, result.reachable]));

  // One lattice cell expressed in degrees of latitude, so boundary distance is
  // comparable to the sampling resolution.
  const cellDegrees = isochrone.data.sampling.resolutionMetres / 111_320;
  const results: SampleClassification[] = classified
    .filter((point) => exact.has(point.id))
    .map((point) => ({
      id: point.id,
      insidePolygon: point.insidePolygon,
      exactReachable: exact.get(point.id) === true,
      cellsFromBoundary: distanceToBoundaryDegrees(geometry, point) / cellDegrees,
    }));

  const summary = summariseAccuracy(results);
  console.log(`resolution        ${isochrone.data.sampling.resolutionMetres.toFixed(0)} m`);
  console.log(`compared          ${summary.total} points`);
  console.log(`near boundary     ${summary.nearBoundary} disagreements (expected, not gated)`);
  console.log(`false inside      ${summary.falseInside}`);
  console.log(`false outside     ${summary.falseOutside}`);

  if (summary.invariantFailures > 0) {
    console.error(
      `\n✗ ${summary.invariantFailures} disagreement(s) more than ${INVARIANT_CELLS} cells from the boundary`,
    );
    process.exit(1);
  }
  console.log("\n✓ no disagreement beyond the sampling resolution");
}

// Only run when invoked directly; the tests import the pure helpers above.
if (process.argv[1]?.includes("benchmark-transit-isochrone-accuracy")) {
  await main();
}
