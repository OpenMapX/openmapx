import {
  type ContributingRecord,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import type { ElevationPoint, ElevationProfile, ElevationStats } from "../types/elevation";
import type { LngLat } from "../types/geometry";
import { haversineDistance } from "./coordinates";

/** Cumulative distance from the start of the geometry to each of its vertices. */
function cumulativeGeometryDistances(geometry: LngLat[]): number[] {
  const distances = [0];
  let total = 0;
  let previous = geometry[0];
  for (const vertex of geometry.slice(1)) {
    if (previous) total += haversineDistance(previous, vertex);
    distances.push(total);
    previous = vertex;
  }
  return distances;
}

/**
 * Build an ElevationProfile from inline Valhalla elevation data.
 * Elevation values are sampled at regular intervals along the route geometry.
 * Without a geometry there is no coordinate to place a sample at, so the
 * profile is empty.
 */
export function buildElevationProfile(
  geometry: LngLat[],
  elevation: number[],
  interval: number,
  provenance?: ContributingRecord & { contributorCoverage?: "partial" },
): ElevationProfile {
  // Compute cumulative distances along the geometry
  const geoDist = cumulativeGeometryDistances(geometry);
  const totalGeoDist = geoDist.at(-1) ?? 0;

  // Map each elevation sample (at regular intervals) to a coordinate on the geometry
  const points: ElevationPoint[] = [];
  for (const [i, sample] of elevation.entries()) {
    const dist = i * interval;
    const lngLat = interpolateAlongGeometry(geometry, geoDist, Math.min(dist, totalGeoDist));
    if (lngLat) points.push({ distance: dist, elevation: sample, lngLat });
  }

  return {
    points,
    stats: computeElevationStats(points),
    ...(provenance
      ? {
          contributors: snapshotContributors(provenance.contributors ?? []),
          ...(provenance.contributorCoverage
            ? { contributorCoverage: provenance.contributorCoverage }
            : {}),
        }
      : {}),
  };
}

/**
 * Build an ElevationProfile from /height API response data.
 * Points already have cumulative distance; we just need to map coordinates.
 */
export function buildElevationProfileFromApi(
  geometry: LngLat[],
  apiPoints: Array<{ distance: number; elevation: number }>,
  provenance?: ContributingRecord & { contributorCoverage?: "partial" },
): ElevationProfile {
  const geoDist = cumulativeGeometryDistances(geometry);
  const totalGeoDist = geoDist.at(-1) ?? 0;

  const points: ElevationPoint[] = apiPoints.flatMap(({ distance, elevation }) => {
    const lngLat = interpolateAlongGeometry(geometry, geoDist, Math.min(distance, totalGeoDist));
    return lngLat ? [{ distance, elevation, lngLat }] : [];
  });

  return {
    points,
    stats: computeElevationStats(points),
    ...(provenance
      ? {
          contributors: snapshotContributors(provenance.contributors ?? []),
          ...(provenance.contributorCoverage
            ? { contributorCoverage: provenance.contributorCoverage }
            : {}),
        }
      : {}),
  };
}

/** Interpolate a point along a geometry at a given cumulative distance; none for an empty geometry. */
function interpolateAlongGeometry(
  geometry: LngLat[],
  cumulativeDist: number[],
  targetDist: number,
): LngLat | undefined {
  const first = geometry[0];
  const last = geometry.at(-1);
  if (!first || !last) return undefined;
  if (targetDist <= 0) return first;
  if (targetDist >= (cumulativeDist.at(-1) ?? 0)) return last;

  // Binary search for the segment containing targetDist
  let lo = 0;
  let hi = cumulativeDist.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    const midDist = cumulativeDist[mid];
    if (midDist !== undefined && midDist <= targetDist) lo = mid;
    else hi = mid;
  }

  const from = geometry[lo];
  const to = geometry[hi];
  const fromDist = cumulativeDist[lo];
  const toDist = cumulativeDist[hi];
  // One distance per vertex, so both ends of the found segment exist.
  if (!from || !to || fromDist === undefined || toDist === undefined) return last;
  const segLen = toDist - fromDist;
  const t = segLen > 0 ? (targetDist - fromDist) / segLen : 0;
  const [lng0, lat0] = from;
  const [lng1, lat1] = to;

  return [lng0 + (lng1 - lng0) * t, lat0 + (lat1 - lat0) * t];
}

/** Compute elevation statistics from an array of ElevationPoints. */
export function computeElevationStats(points: ElevationPoint[]): ElevationStats {
  // Apply light smoothing to reduce DEM noise before computing grades
  const smoothed = smoothElevations(
    points.map((p) => p.elevation),
    3,
  );
  const samples = points.map((point, i) => ({
    distance: point.distance,
    elevation: smoothed[i] ?? point.elevation,
  }));
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last) {
    return {
      totalAscent: 0,
      totalDescent: 0,
      maxElevation: 0,
      minElevation: 0,
      averageGrade: 0,
      maxGrade: 0,
    };
  }

  let totalAscent = 0;
  let totalDescent = 0;
  let maxElevation = first.elevation;
  let minElevation = first.elevation;
  let maxGrade = 0;

  let previous = first;
  for (const sample of samples.slice(1)) {
    const diff = sample.elevation - previous.elevation;
    if (diff > 0) totalAscent += diff;
    else totalDescent += Math.abs(diff);
    if (sample.elevation > maxElevation) maxElevation = sample.elevation;
    if (sample.elevation < minElevation) minElevation = sample.elevation;

    const segDist = sample.distance - previous.distance;
    if (segDist > 0) {
      const grade = Math.abs(diff / segDist) * 100;
      if (grade > maxGrade) maxGrade = grade;
    }
    previous = sample;
  }

  const totalDist = last.distance - first.distance;
  const averageGrade = totalDist > 0 ? (totalAscent / totalDist) * 100 : 0;

  return {
    totalAscent: Math.round(totalAscent),
    totalDescent: Math.round(totalDescent),
    maxElevation: Math.round(maxElevation),
    minElevation: Math.round(minElevation),
    averageGrade: Math.round(averageGrade * 10) / 10,
    maxGrade: Math.round(maxGrade * 10) / 10,
  };
}

/** Simple moving average smoothing to reduce DEM noise. */
function smoothElevations(elevations: number[], windowSize: number): number[] {
  if (elevations.length <= windowSize) return elevations;
  const half = Math.floor(windowSize / 2);
  return elevations.map((_, i) => {
    const start = Math.max(0, i - half);
    const end = Math.min(elevations.length - 1, i + half);
    let sum = 0;
    for (const value of elevations.slice(start, end + 1)) sum += value;
    return sum / (end - start + 1);
  });
}

/** Compute per-segment grades (%) from elevation points. */
export function computeGrades(points: ElevationPoint[]): number[] {
  const grades: number[] = [0]; // first point has no preceding segment
  let previous = points[0];
  for (const point of points.slice(1)) {
    const dist = previous ? point.distance - previous.distance : 0;
    if (previous && dist > 0) {
      grades.push(((point.elevation - previous.elevation) / dist) * 100);
    } else {
      grades.push(0);
    }
    previous = point;
  }
  return grades;
}

/**
 * Largest-Triangle-Three-Buckets (LTTB) downsampling.
 * Preserves visual peaks/valleys while reducing point count for chart rendering.
 */
export function downsampleLTTB(points: ElevationPoint[], targetCount: number): ElevationPoint[] {
  if (points.length <= targetCount) return points;
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return points;
  if (targetCount < 3) return [first, last];

  const sampled: ElevationPoint[] = [first];
  const bucketSize = (points.length - 2) / (targetCount - 2);

  let previous = first;
  for (let i = 0; i < targetCount - 2; i++) {
    const bucketStart = Math.floor((i + 1) * bucketSize) + 1;
    const bucketEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, points.length - 1);

    // Average of next bucket for reference point (use last point if bucket is empty)
    const nextStart = Math.floor((i + 2) * bucketSize) + 1;
    const nextEnd = Math.min(Math.floor((i + 3) * bucketSize) + 1, points.length - 1);
    let avgX: number;
    let avgY: number;
    if (nextStart > nextEnd || nextStart >= points.length) {
      avgX = last.distance;
      avgY = last.elevation;
    } else {
      avgX = 0;
      avgY = 0;
      const nextBucket = points.slice(nextStart, nextEnd + 1);
      for (const point of nextBucket) {
        avgX += point.distance;
        avgY += point.elevation;
      }
      avgX /= nextBucket.length;
      avgY /= nextBucket.length;
    }

    // Find point in current bucket with max triangle area
    let maxArea = -1;
    let chosen = points[bucketStart];
    const px = previous.distance;
    const py = previous.elevation;

    for (const point of points.slice(bucketStart, bucketEnd + 1)) {
      const area = Math.abs(
        (px - avgX) * (point.elevation - py) - (px - point.distance) * (avgY - py),
      );
      if (area > maxArea) {
        maxArea = area;
        chosen = point;
      }
    }

    if (chosen) {
      sampled.push(chosen);
      previous = chosen;
    }
  }

  sampled.push(last);
  return sampled;
}
