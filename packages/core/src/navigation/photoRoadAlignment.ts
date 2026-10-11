import type { LngLat } from "../types/geometry";
import type { JunctionDecisionPoint, JunctionWay } from "../types/junction";
import type { StreetLevelImage } from "../types/streetLevel";
import { cumulativeDistances, positionAt } from "./deadReckon";
import { photoApproachEvidence } from "./photoApproach";
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

function wrap(value: number, width: number): number {
  return ((value % width) + width) % width;
}

function spread(
  source: Float32Array,
  width: number,
  height: number,
  radius: number,
  panoramic: boolean,
): Float32Array {
  const horizontal = new Float32Array(source.length);
  const result = new Float32Array(source.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let value = 0;
      for (let delta = -radius; delta <= radius; delta++) {
        if (!panoramic && (x + delta < 0 || x + delta >= width)) continue;
        value = Math.max(
          value,
          source[y * width + (panoramic ? wrap(x + delta, width) : x + delta)] *
            (1 - Math.abs(delta) / (radius + 1)),
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
    for (let x = panoramic ? 0 : side; x < (panoramic ? width : width - side); x++) {
      const at = y * width + x;
      const contrast = Math.max(
        ...[side, side * 2, side * 4]
          .filter((d) => panoramic || (x > d && x < width - d))
          .map(
            (d) =>
              grey[at] -
              (grey[y * width + (panoramic ? wrap(x - d, width) : x - d)] +
                grey[y * width + (panoramic ? wrap(x + d, width) : x + d)]) /
                2,
          ),
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
    paint: spread(paint, width, height, 2, panoramic),
    coarsePaint: spread(paint, width, height, 7, panoramic),
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
      const rawX = Math.round((at.xPercent / 100) * features.width);
      const x = image.isPano ? wrap(rawX, features.width) : rawX;
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
        const rawX = pixel ? Math.round((pixel.xPercent * features.width) / 100) : -1;
        const x = image.isPano && pixel ? wrap(rawX, features.width) : rawX;
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

export const PHOTO_REGISTRATION_VERSION = "observed-boundaries-v2";
export type PhotoRegistrationReason =
  | "wrong-level"
  | "off-approach"
  | "missing-fov"
  | "unclear-scene"
  | "layout-unknown"
  | "layout-mismatch"
  | "ambiguous-fit"
  | "insufficient-boundaries";
export interface PhotoRegistrationResult {
  version: typeof PHOTO_REGISTRATION_VERSION;
  scene: "relevant" | "rejected" | "uncertain";
  reason?: PhotoRegistrationReason;
  alignment: PhotoRoadAlignment | null;
  /** Raw feature/fit scores, not calibrated probabilities. */
  evidence: { roadFraction: number; markingFraction: number; observedBoundaries: number };
}

export function registerPhotoRoad(
  geometry: LngLat[],
  point: JunctionDecisionPoint,
  image: StreetLevelImage,
  pixels: PhotoPixels,
  laneCount?: number,
  approachWay?: JunctionWay,
  approachWays?: JunctionWay[],
): PhotoRegistrationResult {
  const evidence = { roadFraction: 0, markingFraction: 0, observedBoundaries: 0 };
  const reject = (
    reason: PhotoRegistrationReason,
    scene: PhotoRegistrationResult["scene"] = "rejected",
  ): PhotoRegistrationResult => ({
    version: PHOTO_REGISTRATION_VERSION,
    scene,
    reason,
    alignment: null,
    evidence,
  });
  if (approachWays) {
    const context = photoApproachEvidence(geometry, point, image, approachWays);
    if (context.state !== "known") return reject("off-approach");
    approachWay = context.way;
  }
  if (approachWay?.tunnel || (approachWay?.layer ?? 0) < 0) return reject("wrong-level");
  if (
    geometry.length < 2 ||
    !approachCamera(geometry, cumulativeDistances(geometry), point, image.lngLat).onApproach
  )
    return reject("off-approach");
  if (
    pixels.width < 100 ||
    pixels.height < 100 ||
    pixels.width > 2048 ||
    pixels.height > 2048 ||
    pixels.data.length !== pixels.width * pixels.height * 4
  )
    return reject("unclear-scene");
  const features = roadFeatures(pixels, image.isPano);
  const camera = approachCamera(geometry, cumulativeDistances(geometry), point, image.lngLat);
  const centre = image.isPano
    ? (((0.5 + (camera.bearing - (image.heading ?? 0)) / 360) % 1) + 1) % 1
    : 0.5;
  let count = 0,
    road = 0,
    paint = 0;
  const bottom = image.isPano ? 0.7 : 0.94;
  const top = image.isPano ? 0.515 : 0.58;
  const half = image.isPano ? 0.09 : 0.3;
  for (let y = Math.ceil(pixels.height * top); y < pixels.height * bottom; y++)
    for (let dx = -Math.floor(pixels.width * half); dx <= pixels.width * half; dx++) {
      const x =
        (((Math.round(centre * pixels.width) + dx) % pixels.width) + pixels.width) % pixels.width;
      const at = y * pixels.width + x;
      count++;
      road += features.road[at];
      if (features.paint[at] > 0.35) paint++;
    }
  evidence.roadFraction = road / count;
  evidence.markingFraction = paint / count;
  if (evidence.roadFraction < 0.2 || evidence.markingFraction < 0.002)
    return reject("unclear-scene");
  if (!laneCount) return reject("layout-unknown", "relevant");
  if (approachWay?.tags.lanes !== undefined && approachWay.tags.lanes !== laneCount)
    return reject("layout-mismatch", "relevant");
  if (!image.isPano && (!image.fovDeg || image.fovDeg <= 0 || image.fovDeg >= 180))
    return reject("missing-fov", "relevant");
  // A sphere has no privileged seam. Fit one road-centred phase so equivalent
  // source rotations cannot select different pitch/roll minima.
  const shift =
    image.isPano && image.heading !== undefined
      ? Math.floor(pixels.width / 2) - Math.round(centre * pixels.width)
      : 0;
  const fittingPixels = shift ? rotatePanoramaPixels(pixels, shift) : pixels;
  const fittingImage = shift
    ? { ...image, heading: wrap(image.heading! - (shift * 360) / pixels.width, 360) }
    : image;
  const alignment = alignPhotoRoad(geometry, point, fittingImage, fittingPixels, laneCount);
  if (!alignment) return reject("insufficient-boundaries", "relevant");
  const observed = observeBoundaries(
    geometry,
    point,
    fittingImage,
    alignment,
    shift ? roadFeatures(fittingPixels, true) : features,
    laneCount,
  );
  if (!observed) return reject("insufficient-boundaries", "relevant");
  const sourcePose = shift
    ? rotatePanoramaPose(alignment, (-shift * 360) / pixels.width)
    : alignment;
  const sourceCentre = wrap(50 + (camera.bearing - sourcePose.headingDeg) / 3.6, 100);
  const sourceObserved = shift
    ? observed.map((sample) => ({
        ...sample,
        boundaries: sample.boundaries.map((boundary) => {
          const x = boundary.xPercent - (shift * 100) / pixels.width;
          return { ...boundary, xPercent: x + Math.round((sourceCentre - x) / 100) * 100 };
        }),
      }))
    : observed;
  evidence.observedBoundaries = laneCount + 1;
  return {
    version: PHOTO_REGISTRATION_VERSION,
    scene: "relevant",
    alignment: { ...sourcePose, observed: sourceObserved },
    evidence,
  };
}

function rotatePanoramaPixels(pixels: PhotoPixels, shift: number): PhotoPixels {
  const data = new Uint8ClampedArray(pixels.data.length);
  for (let y = 0; y < pixels.height; y++) {
    const row = y * pixels.width * 4;
    const start = wrap(-shift, pixels.width) * 4;
    const first = pixels.width * 4 - start;
    data.set(pixels.data.subarray(row + start, row + pixels.width * 4), row);
    data.set(pixels.data.subarray(row, row + start), row + first);
  }
  return { width: pixels.width, height: pixels.height, data };
}

/** Express the same 3D camera rotation in the source panorama's horizontal phase. */
function rotatePanoramaPose(pose: PhotoRoadAlignment, degrees: number): PhotoRoadAlignment {
  const radians = Math.PI / 180;
  const heading = pose.headingDeg * radians,
    pitch = pose.pitchDeg * radians,
    roll = pose.rollDeg * radians;
  const sh = Math.sin(heading),
    ch = Math.cos(heading),
    sp = Math.sin(pitch),
    cp = Math.cos(pitch),
    sr = Math.sin(roll),
    cr = Math.cos(roll);
  const s = Math.sin(degrees * radians),
    c = Math.cos(degrees * radians);
  const east = sh * cp * c - (ch * cr - sh * sp * sr) * s;
  const north = ch * cp * c - (-sh * cr - ch * sp * sr) * s;
  return {
    ...pose,
    headingDeg: wrap(Math.atan2(east, north) / radians, 360),
    pitchDeg: Math.asin(Math.max(-1, Math.min(1, sp * c - cp * sr * s))) / radians,
    rollDeg: Math.atan2(cp * sr * c + sp * s, cp * cr) / radians,
  };
}

/** Trace paint close to a supported pose; retain image-space curves rather than uniform lane widths. */
function observeBoundaries(
  geometry: LngLat[],
  point: JunctionDecisionPoint,
  image: StreetLevelImage,
  alignment: PhotoRoadAlignment,
  features: RoadFeatures,
  laneCount: number,
): NonNullable<PhotoRoadAlignment["observed"]> | null {
  const cum = cumulativeDistances(geometry);
  const camera = approachCamera(geometry, cum, point, image.lngLat);
  const project = photoGroundProjector(image, alignment, features.width / features.height);
  if (!project) return null;
  const radians = Math.PI / 180;
  const right = [Math.cos(camera.bearing * radians), -Math.sin(camera.bearing * radians)];
  const centre = wrap(50 + (camera.bearing - alignment.headingDeg) / 3.6, 100);
  const unwrapped = (pixel: NonNullable<ReturnType<typeof project>>) => ({
    ...pixel,
    xPercent: image.isPano
      ? pixel.xPercent + Math.round((centre - pixel.xPercent) / 100) * 100
      : pixel.xPercent,
  });
  const observations = Array.from(
    { length: laneCount + 1 },
    () => [] as Array<{ meters: number; xPercent: number; yPercent: number }>,
  );
  for (let meters = alignment.fromMeters; meters <= alignment.toMeters; meters++) {
    const at = positionAt(geometry, cum, camera.alongMeters + meters);
    const east =
      (at.point[0] - camera.point[0]) * METERS_PER_DEGREE * Math.cos(camera.point[1] * radians) -
      right[0] * alignment.lateralOffsetMeters;
    const north =
      (at.point[1] - camera.point[1]) * METERS_PER_DEGREE -
      right[1] * alignment.lateralOffsetMeters;
    const predicted = Array.from({ length: laneCount + 1 }, (_, boundary) => {
      const offset = (boundary - laneCount / 2) * LANE_WIDTH_M;
      const pixel = project(
        east + Math.cos(at.bearing * radians) * offset,
        north - Math.sin(at.bearing * radians) * offset,
      );
      return pixel ? unwrapped(pixel) : null;
    });
    for (let boundary = 0; boundary <= laneCount; boundary++) {
      const pixel = predicted[boundary];
      if (!pixel) continue;
      const y = Math.round((pixel.yPercent * features.height) / 100);
      if (y < 0 || y >= features.height) continue;
      const x = Math.round((pixel.xPercent * features.width) / 100);
      const neighbour = predicted[boundary === laneCount ? boundary - 1 : boundary + 1];
      const radius = Math.max(
        1,
        Math.min(
          12,
          Math.floor(
            ((Math.abs((neighbour?.xPercent ?? pixel.xPercent) - pixel.xPercent) * features.width) /
              100) *
              0.12,
          ),
        ),
      );
      let best = 0.35,
        hit: number | undefined;
      for (let delta = -radius; delta <= radius; delta++) {
        const sample = image.isPano
          ? (((x + delta) % features.width) + features.width) % features.width
          : x + delta;
        if (sample < 0 || sample >= features.width) continue;
        const strength = features.paint[y * features.width + sample] - Math.abs(delta) * 0.004;
        if (strength > best) {
          best = strength;
          hit = x + delta;
        }
      }
      if (hit !== undefined)
        observations[boundary].push({
          meters,
          xPercent: (hit * 100) / features.width,
          yPercent: pixel.yPercent,
        });
    }
  }
  if (observations.some((boundary) => boundary.length < 4)) return null;
  const from = Math.max(...observations.map((boundary) => boundary[0].meters));
  const to = Math.min(...observations.map((boundary) => boundary.at(-1)!.meters));
  if (to - from < 12) return null;
  const result: NonNullable<PhotoRoadAlignment["observed"]> = [];
  for (let meters = from; meters <= to; meters++) {
    const boundaries = observations.map((boundary) => {
      const after = boundary.findIndex((sample) => sample.meters >= meters);
      const a = boundary[Math.max(0, after - 1)],
        b = boundary[after];
      const mix = b.meters === a.meters ? 0 : (meters - a.meters) / (b.meters - a.meters);
      return {
        xPercent: a.xPercent + (b.xPercent - a.xPercent) * mix,
        yPercent: a.yPercent + (b.yPercent - a.yPercent) * mix,
      };
    });
    if (
      boundaries.some(
        (boundary, index) => index > 0 && boundary.xPercent <= boundaries[index - 1].xPercent,
      )
    )
      return null;
    result.push({ distanceMeters: meters, boundaries });
  }
  return result;
}
