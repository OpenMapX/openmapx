import type { LngLat } from "../types/geometry";
import type { JunctionDecisionPoint } from "../types/junction";
import type { StreetLevelImage } from "../types/streetLevel";
import { cumulativeDistances, positionAt } from "./deadReckon";
import {
  approachCamera,
  type PhotoCameraPose,
  type PhotoRoadAlignment,
  photoGroundProjector,
} from "./photoProjection";

export interface PhotoPixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

interface GroundSample {
  east: number;
  north: number;
  rightEast: number;
  rightNorth: number;
  meters: number;
}

interface RoadFeatures {
  width: number;
  height: number;
  paint: Float32Array;
  coarsePaint: Float32Array;
  road: Uint8Array;
}

interface Fit {
  pose: PhotoCameraPose;
  score: number;
  paint: number[];
  paintBands: number[][];
  road: number[];
  paintHits: number[][];
}

const LANE_WIDTH_M = 3.5;
const METERS_PER_DEGREE = 111_320;

function spread(source: Float32Array, width: number, height: number, radius: number): Float32Array {
  const horizontal = new Float32Array(source.length);
  const result = new Float32Array(source.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let value = 0;
      for (let delta = -radius; delta <= radius; delta++) {
        if (x + delta < 0 || x + delta >= width) continue;
        value = Math.max(
          value,
          source[y * width + x + delta] * (1 - Math.abs(delta) / (radius + 1)),
        );
      }
      horizontal[y * width + x] = value;
    }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let value = 0;
      for (let delta = -radius; delta <= radius; delta++) {
        if (y + delta < 0 || y + delta >= height) continue;
        value = Math.max(
          value,
          horizontal[(y + delta) * width + x] * (1 - Math.abs(delta) / (radius + 1)),
        );
      }
      result[y * width + x] = value;
    }
  return result;
}

/** Narrow neutral paint ridges and neutral pavement exclude foliage and broad bright barriers. */
function roadFeatures(pixels: PhotoPixels, panoramic: boolean): RoadFeatures {
  const { width, height, data } = pixels;
  const grey = new Float32Array(width * height);
  const road = new Uint8Array(width * height);
  for (let at = 0; at < grey.length; at++) {
    const minimum = Math.min(data[at * 4], data[at * 4 + 1], data[at * 4 + 2]);
    const range = Math.max(data[at * 4], data[at * 4 + 1], data[at * 4 + 2]) - minimum;
    grey[at] = minimum;
    road[at] = range < minimum * 0.22 && minimum > 45 && minimum < 180 ? 1 : 0;
  }
  const paint = new Float32Array(grey.length);
  const side = Math.max(3, Math.round(width / 340));
  for (
    let y = Math.ceil(height * (panoramic ? 0.505 : 0.45));
    y < height * (panoramic ? 0.7 : 0.97);
    y++
  ) {
    for (let x = side; x < width - side; x++) {
      const at = y * width + x;
      const contrast = Math.max(
        ...[side, side * 2, side * 4]
          .filter((d) => x > d && x < width - d)
          .map((d) => grey[at] - (grey[at - d] + grey[at + d]) / 2),
      );
      const range = Math.max(data[at * 4], data[at * 4 + 1], data[at * 4 + 2]) - grey[at];
      if (range < 65)
        paint[at] =
          Math.max(0, Math.min(1, (contrast - 12) / 45)) *
          Math.max(0, Math.min(1, (grey[at] - 90) / 70));
    }
  }
  return {
    width,
    height,
    road,
    paint: spread(paint, width, height, 2),
    coarsePaint: spread(paint, width, height, 7),
  };
}

function fitPose(
  pose: PhotoCameraPose,
  image: StreetLevelImage,
  samples: GroundSample[],
  laneCount: number,
  features: RoadFeatures,
  eyeRight: [number, number],
  coarse: boolean,
): Fit {
  const project = photoGroundProjector(image, pose, features.width / features.height);
  const paint = Array<number>(laneCount + 1).fill(0);
  const paintHits = Array.from({ length: laneCount + 1 }, () => [0, 0]);
  const paintBands = Array.from({ length: laneCount + 1 }, () => [0, 0, 0]);
  const road = Array<number>(laneCount).fill(0);
  if (!project) return { pose, score: 0, paint, paintBands, paintHits, road };
  for (let boundary = 0; boundary <= laneCount * 2; boundary++) {
    const offset = (boundary / 2 - laneCount / 2) * LANE_WIDTH_M;
    let support = 0;
    for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
      const sample = samples[sampleIndex];
      const at = project(
        sample.east + sample.rightEast * offset - eyeRight[0] * pose.lateralOffsetMeters,
        sample.north + sample.rightNorth * offset - eyeRight[1] * pose.lateralOffsetMeters,
      );
      if (!at) continue;
      const x = Math.round((at.xPercent / 100) * features.width);
      const y = Math.round((at.yPercent / 100) * features.height);
      if (x < 0 || x >= features.width || y < 0 || y >= features.height) continue;
      const index = y * features.width + x;
      const value =
        boundary % 2
          ? features.road[index]
          : coarse
            ? features.coarsePaint[index]
            : features.paint[index];
      support += value;
      if (boundary % 2 === 0 && value > 0.35)
        paintHits[boundary / 2][sampleIndex < samples.length / 2 ? 0 : 1]++;
      if (boundary % 2 === 0)
        paintBands[boundary / 2][Math.floor((sampleIndex * 3) / samples.length)] += value;
    }
    if (boundary % 2) road[(boundary - 1) / 2] = support / samples.length;
    else paint[boundary / 2] = support / samples.length;
  }
  const roadSupport = road.reduce((sum, v) => sum + v, 0) / road.length;
  for (const bands of paintBands)
    for (let band = 0; band < 3; band++) {
      const count = samples.filter(
        (_, index) => Math.floor((index * 3) / samples.length) === band,
      ).length;
      bands[band] /= count;
    }
  const paintSupport = paint.reduce((sum, v) => sum + v, 0) / paint.length;
  return {
    pose,
    paint,
    paintBands,
    paintHits,
    road,
    score: paintSupport * roadSupport ** 3,
  };
}

function supported(fit: Fit, laneCount: number): boolean {
  return (
    fit.score >= 0.2 &&
    fit.paint.every((value) => value >= 0.12) &&
    fit.paintBands[0].every((v) => v >= 0.18) &&
    fit.paintBands[laneCount].every((v) => v >= 0.18) &&
    fit.paintHits.every((h) => h[0] >= 1 && h[1] >= 1 && h[0] + h[1] >= 3) &&
    Math.min(fit.paint[0], fit.paint[laneCount]) >= 0.3 &&
    fit.road.every((value) => value >= 0.8)
  );
}

/** Search bounded camera poses using repeated markings and pavement between them. */
function fitRoad(
  geometry: LngLat[],
  point: JunctionDecisionPoint,
  image: StreetLevelImage,
  pixels: PhotoPixels,
  laneCount: number,
): Fit[] {
  if (
    !Number.isInteger(laneCount) ||
    laneCount < 1 ||
    laneCount > 7 ||
    image.heading === undefined ||
    !Number.isFinite(image.heading) ||
    !Number.isInteger(pixels.width) ||
    !Number.isInteger(pixels.height) ||
    pixels.width < 100 ||
    pixels.height < 100 ||
    pixels.width > 2048 ||
    pixels.height > 2048 ||
    pixels.data.length !== pixels.width * pixels.height * 4 ||
    geometry.length < 2
  )
    return [];
  const cum = cumulativeDistances(geometry);
  const camera = approachCamera(geometry, cum, point, image.lngLat);
  if (!camera.onApproach) return [];
  const end = Math.min(70, point.alongMeters - camera.alongMeters - 8);
  const samples: GroundSample[] = [];
  const radians = Math.PI / 180;
  for (let meters = 8; meters <= end; meters += 3) {
    const at = positionAt(geometry, cum, camera.alongMeters + meters);
    samples.push({
      east:
        (at.point[0] - camera.point[0]) * METERS_PER_DEGREE * Math.cos(camera.point[1] * radians),
      north: (at.point[1] - camera.point[1]) * METERS_PER_DEGREE,
      rightEast: Math.cos(at.bearing * radians),
      rightNorth: -Math.sin(at.bearing * radians),
      meters,
    });
  }
  if (samples.length < 6) return [];
  const features = roadFeatures(pixels, image.isPano);
  if (!features.coarsePaint.some((value) => value > 0.2)) return [];
  const eyeRight: [number, number] = [
    Math.cos(camera.bearing * radians),
    -Math.sin(camera.bearing * radians),
  ];
  const outer = ((laneCount - 1) * LANE_WIDTH_M) / 2 + 0.5;
  const pool: Fit[] = [];
  const score = (pose: PhotoCameraPose, coarse: boolean) =>
    fitPose(pose, image, samples, laneCount, features, eyeRight, coarse);
  const headings = Array.from({ length: 13 }, (_, index) => -6 + index);
  const pitches = image.isPano
    ? [-2, 0, 2]
    : Array.from({ length: 18 }, (_, index) => -20 + index * 2);
  const offsets = Array.from(
    { length: laneCount * 2 + 1 },
    (_, index) => -outer + (index * outer) / laneCount,
  );
  for (const correction of headings)
    for (const cameraHeightM of [1.1, 1.5, 2, 2.5, 3]) {
      for (const pitchDeg of pitches)
        for (const lateralOffsetMeters of offsets) {
          const fit = score(
            {
              headingDeg: image.heading + correction,
              cameraHeightM,
              pitchDeg,
              rollDeg: 0,
              lateralOffsetMeters,
            },
            true,
          );
          pool.push(fit);
          pool.sort((a, b) => b.score - a.score);
          if (pool.length > 12) pool.pop();
        }
    }
  const bounds: Record<keyof PhotoCameraPose, [number, number]> = {
    headingDeg: [image.heading - 6, image.heading + 6],
    cameraHeightM: [0.9, 3.5],
    pitchDeg: image.isPano ? [-3, 3] : [-20, 15],
    rollDeg: [-3, 3],
    lateralOffsetMeters: [-outer, outer],
  };
  const refined: Fit[] = [];
  for (const seed of pool) {
    let best = score(seed.pose, false);
    for (let tier = 0; tier < 5; tier++) {
      const steps: Record<keyof PhotoCameraPose, number> = {
        headingDeg: 4 / 2 ** tier,
        cameraHeightM: 0.4 / 2 ** tier,
        lateralOffsetMeters: 1 / 2 ** tier,
        pitchDeg: (image.isPano ? 0.5 : 3) / 2 ** tier,
        rollDeg: 1 / 2 ** tier,
      };
      for (let iteration = 0; iteration < 4; iteration++) {
        let changed = false;
        for (const key of Object.keys(steps) as (keyof PhotoCameraPose)[])
          for (const direction of [-1, 1]) {
            const value = best.pose[key] + direction * steps[key];
            if (value < bounds[key][0] || value > bounds[key][1]) continue;
            const fit = score({ ...best.pose, [key]: value }, false);
            if (fit.score > best.score) {
              best = fit;
              changed = true;
            }
          }
        if (!changed) break;
      }
    }
    if (supported(best, laneCount)) refined.push(best);
  }
  refined.sort((a, b) => b.score - a.score);
  return refined;
}

/**
 * Register the known lane layout against the image. Both road edges and dashed
 * dividers must be visible; shoulders are allowed, additional lanes are not.
 * Only a contiguous, near-forward stretch supported by pavement is returned.
 * Ambiguous or weak imagery leaves the photo bare.
 */
export function alignPhotoRoad(
  geometry: LngLat[],
  point: JunctionDecisionPoint,
  image: StreetLevelImage,
  pixels: PhotoPixels,
  laneCount: number,
): PhotoRoadAlignment | null {
  if (!Number.isInteger(laneCount) || laneCount < 1 || laneCount > 6) return null;
  const refined = fitRoad(geometry, point, image, pixels, laneCount);
  const best = refined[0];
  if (!best) return null;
  // A competing layout with an additional lane means the photographed approach
  // cannot safely be indexed using the junction's lane count.
  if (fitRoad(geometry, point, image, pixels, laneCount + 1).length > 0) return null;
  if (
    refined.some(
      (fit) =>
        best.score - fit.score < 0.02 &&
        Math.abs(best.pose.lateralOffsetMeters - fit.pose.lateralOffsetMeters) >
          LANE_WIDTH_M * 0.75,
    )
  )
    return null;
  const cum = cumulativeDistances(geometry);
  const camera = approachCamera(geometry, cum, point, image.lngLat);
  const features = roadFeatures(pixels, image.isPano);
  const radians = Math.PI / 180;
  const eyeRight: [number, number] = [
    Math.cos(camera.bearing * radians),
    -Math.sin(camera.bearing * radians),
  ];
  const last = Math.min(68, point.alongMeters - camera.alongMeters - 8);
  const project = photoGroundProjector(image, best.pose, features.width / features.height);
  if (!project) return null;
  let first = 0,
    longestFirst = 0,
    longestLast = 0;
  for (let meters = 8; meters <= last; meters++) {
    const at = positionAt(geometry, cum, camera.alongMeters + meters);
    const east =
      (at.point[0] - camera.point[0]) * METERS_PER_DEGREE * Math.cos(camera.point[1] * radians);
    const north = (at.point[1] - camera.point[1]) * METERS_PER_DEGREE;
    let onRoad = true;
    for (let lane = 0; lane < laneCount; lane++)
      for (const edge of [-0.8, 0, 0.8]) {
        const offset = (lane - (laneCount - 1) / 2) * LANE_WIDTH_M + edge;
        const pixel = project(
          east +
            Math.cos(at.bearing * radians) * offset -
            eyeRight[0] * best.pose.lateralOffsetMeters,
          north -
            Math.sin(at.bearing * radians) * offset -
            eyeRight[1] * best.pose.lateralOffsetMeters,
        );
        const x = pixel ? Math.round((pixel.xPercent * features.width) / 100) : -1;
        const y = pixel ? Math.round((pixel.yPercent * features.height) / 100) : -1;
        if (
          x < 0 ||
          x >= features.width ||
          y < 0 ||
          y >= features.height ||
          !features.road[y * features.width + x]
        )
          onRoad = false;
      }
    if (!onRoad) first = 0;
    else {
      if (!first) first = meters;
      if (meters - first > longestLast - longestFirst) {
        longestFirst = first;
        longestLast = meters;
      }
    }
  }
  if (longestFirst > 16 || longestLast - longestFirst < 18) return null;
  return { ...best.pose, fromMeters: longestFirst, toMeters: longestLast };
}
