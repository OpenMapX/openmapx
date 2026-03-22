import type { ElevationPoint, ElevationProfile, ElevationStats } from "../types/elevation";
import type { LngLat } from "../types/geometry";
import { haversineDistance } from "./coordinates";

/**
 * Build an ElevationProfile from inline Valhalla elevation data.
 * Elevation values are sampled at regular intervals along the route geometry.
 */
export function buildElevationProfile(
  geometry: LngLat[],
  elevation: number[],
  interval: number,
): ElevationProfile {
  // Compute cumulative distances along the geometry
  const geoDist: number[] = [0];
  for (let i = 1; i < geometry.length; i++) {
    geoDist.push(geoDist[i - 1] + haversineDistance(geometry[i - 1], geometry[i]));
  }
  const totalGeoDist = geoDist[geoDist.length - 1];

  // Map each elevation sample (at regular intervals) to a coordinate on the geometry
  const points: ElevationPoint[] = [];
  for (let i = 0; i < elevation.length; i++) {
    const dist = i * interval;
    const lngLat = interpolateAlongGeometry(geometry, geoDist, Math.min(dist, totalGeoDist));
    points.push({ distance: dist, elevation: elevation[i], lngLat });
  }

  return { points, stats: computeElevationStats(points) };
}

/**
 * Build an ElevationProfile from /height API response data.
 * Points already have cumulative distance; we just need to map coordinates.
 */
export function buildElevationProfileFromApi(
  geometry: LngLat[],
  apiPoints: Array<{ distance: number; elevation: number }>,
): ElevationProfile {
  const geoDist: number[] = [0];
  for (let i = 1; i < geometry.length; i++) {
    geoDist.push(geoDist[i - 1] + haversineDistance(geometry[i - 1], geometry[i]));
  }
  const totalGeoDist = geoDist[geoDist.length - 1];

  const points: ElevationPoint[] = apiPoints.map(({ distance, elevation }) => ({
    distance,
    elevation,
    lngLat: interpolateAlongGeometry(geometry, geoDist, Math.min(distance, totalGeoDist)),
  }));

  return { points, stats: computeElevationStats(points) };
}

/** Interpolate a point along a geometry at a given cumulative distance. */
function interpolateAlongGeometry(
  geometry: LngLat[],
  cumulativeDist: number[],
  targetDist: number,
): LngLat {
  if (targetDist <= 0) return geometry[0];
  if (targetDist >= cumulativeDist[cumulativeDist.length - 1]) {
    return geometry[geometry.length - 1];
  }

  // Binary search for the segment containing targetDist
  let lo = 0;
  let hi = cumulativeDist.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cumulativeDist[mid] <= targetDist) lo = mid;
    else hi = mid;
  }

  const segLen = cumulativeDist[hi] - cumulativeDist[lo];
  const t = segLen > 0 ? (targetDist - cumulativeDist[lo]) / segLen : 0;
  const [lng0, lat0] = geometry[lo];
  const [lng1, lat1] = geometry[hi];

  return [lng0 + (lng1 - lng0) * t, lat0 + (lat1 - lat0) * t];
}

/** Compute elevation statistics from an array of ElevationPoints. */
export function computeElevationStats(points: ElevationPoint[]): ElevationStats {
  if (points.length === 0) {
    return {
      totalAscent: 0,
      totalDescent: 0,
      maxElevation: 0,
      minElevation: 0,
      averageGrade: 0,
      maxGrade: 0,
    };
  }

  // Apply light smoothing to reduce DEM noise before computing grades
  const smoothed = smoothElevations(
    points.map((p) => p.elevation),
    3,
  );

  let totalAscent = 0;
  let totalDescent = 0;
  let maxElevation = smoothed[0];
  let minElevation = smoothed[0];
  let maxGrade = 0;

  for (let i = 1; i < smoothed.length; i++) {
    const diff = smoothed[i] - smoothed[i - 1];
    if (diff > 0) totalAscent += diff;
    else totalDescent += Math.abs(diff);
    if (smoothed[i] > maxElevation) maxElevation = smoothed[i];
    if (smoothed[i] < minElevation) minElevation = smoothed[i];

    const segDist = points[i].distance - points[i - 1].distance;
    if (segDist > 0) {
      const grade = Math.abs(diff / segDist) * 100;
      if (grade > maxGrade) maxGrade = grade;
    }
  }

  const totalDist = points[points.length - 1].distance - points[0].distance;
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
    for (let j = start; j <= end; j++) sum += elevations[j];
    return sum / (end - start + 1);
  });
}

/** Compute per-segment grades (%) from elevation points. */
export function computeGrades(points: ElevationPoint[]): number[] {
  const grades: number[] = [0]; // first point has no preceding segment
  for (let i = 1; i < points.length; i++) {
    const dist = points[i].distance - points[i - 1].distance;
    if (dist > 0) {
      grades.push(((points[i].elevation - points[i - 1].elevation) / dist) * 100);
    } else {
      grades.push(0);
    }
  }
  return grades;
}

/**
 * Largest-Triangle-Three-Buckets (LTTB) downsampling.
 * Preserves visual peaks/valleys while reducing point count for chart rendering.
 */
export function downsampleLTTB(points: ElevationPoint[], targetCount: number): ElevationPoint[] {
  if (points.length <= targetCount) return points;
  if (targetCount < 3) return [points[0], points[points.length - 1]];

  const sampled: ElevationPoint[] = [points[0]];
  const bucketSize = (points.length - 2) / (targetCount - 2);

  let prevIndex = 0;
  for (let i = 0; i < targetCount - 2; i++) {
    const bucketStart = Math.floor((i + 1) * bucketSize) + 1;
    const bucketEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, points.length - 1);

    // Average of next bucket for reference point (use last point if bucket is empty)
    const nextStart = Math.floor((i + 2) * bucketSize) + 1;
    const nextEnd = Math.min(Math.floor((i + 3) * bucketSize) + 1, points.length - 1);
    let avgX: number;
    let avgY: number;
    if (nextStart > nextEnd || nextStart >= points.length) {
      const last = points[points.length - 1];
      avgX = last.distance;
      avgY = last.elevation;
    } else {
      avgX = 0;
      avgY = 0;
      let count = 0;
      for (let j = nextStart; j <= nextEnd && j < points.length; j++) {
        avgX += points[j].distance;
        avgY += points[j].elevation;
        count++;
      }
      avgX /= count;
      avgY /= count;
    }

    // Find point in current bucket with max triangle area
    let maxArea = -1;
    let maxIndex = bucketStart;
    const px = points[prevIndex].distance;
    const py = points[prevIndex].elevation;

    for (let j = bucketStart; j <= bucketEnd && j < points.length; j++) {
      const area = Math.abs(
        (px - avgX) * (points[j].elevation - py) - (px - points[j].distance) * (avgY - py),
      );
      if (area > maxArea) {
        maxArea = area;
        maxIndex = j;
      }
    }

    sampled.push(points[maxIndex]);
    prevIndex = maxIndex;
  }

  sampled.push(points[points.length - 1]);
  return sampled;
}
