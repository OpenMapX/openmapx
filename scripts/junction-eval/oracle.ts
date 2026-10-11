export type Pixel = [number, number];
export interface ReferenceFrame {
  id: string;
  site: string;
  sequence: string;
  region: string;
  split: "calibration" | "development" | "holdout";
  source: "synthetic" | "pr-raw-osm" | "deployed-mapper";
  collectedAt: string;
  revision: string;
  evidenceHash: string;
  categories: string[];
  photo?: { id: string; hash: string; license: string; width: number; height: number };
  truth?: {
    certainty: "certain" | "uncertain";
    reviewers: string[];
    evidence: string;
    photoRelevant: boolean;
    clearMarkedSupported: boolean;
    preferredLanes: number[];
    /** Zero means no photographed layout is claimed for an irrelevant scene. */
    laneCount: number;
    signSpans: number[][];
    travelLanes: Pixel[][];
    /** Separate labelled patches; unlabelled pixels have unknown lane-surface status. */
    travelLaneFragments?: { lane: number; polygon: Pixel[] }[];
    maskScope?: "complete" | "visible-fragments";
    forbidden: Pixel[][];
  };
}
export interface FrameOutput {
  id: string;
  photoShown: boolean;
  ribbons: { lane: number; polygon: Pixel[] }[];
}

function hasArea(polygon: Pixel[]): boolean {
  if (polygon.length < 3 || polygon.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y)))
    return false;
  let area = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x, y] = polygon[i];
    const [nextX, nextY] = polygon[(i + 1) % polygon.length];
    area += x * nextY - nextX * y;
  }
  return Number.isFinite(area) && area !== 0;
}

export function validateCorpus(frames: ReferenceFrame[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const sites = new Map<string, ReferenceFrame["split"]>();
  const sequences = new Map<string, ReferenceFrame["split"]>();
  for (const frame of frames) {
    const fail = (message: string) => errors.push(`${frame.id}: ${message}`);
    if (ids.has(frame.id)) fail("duplicate id");
    ids.add(frame.id);
    if (!frame.site || !frame.sequence || !frame.region) fail("site, sequence or region missing");
    if (!/^[a-f0-9]{64}$/.test(frame.evidenceHash) || !/^[a-f0-9]{40}$/.test(frame.revision))
      fail("evidence hash or revision missing");
    if (!Number.isFinite(Date.parse(frame.collectedAt))) fail("collection time missing");
    if (sites.has(frame.site) && sites.get(frame.site) !== frame.split)
      errors.push(`${frame.site}: site crosses splits`);
    if (sequences.has(frame.sequence) && sequences.get(frame.sequence) !== frame.split)
      errors.push(`${frame.sequence}: sequence crosses splits`);
    sites.set(frame.site, frame.split);
    sequences.set(frame.sequence, frame.split);
    const photo = frame.photo;
    if (photo && (!/^[a-f0-9]{64}$/.test(photo.hash) || !photo.license.trim()))
      fail("photo hash or license missing");
    if (
      photo &&
      (!Number.isInteger(photo.width) ||
        !Number.isInteger(photo.height) ||
        photo.width <= 0 ||
        photo.height <= 0)
    )
      fail("invalid photo dimensions");
    const truth = frame.truth;
    if (!truth) continue;
    if (!truth.evidence.trim()) fail("annotation evidence missing");
    if (truth.certainty === "certain" && new Set(truth.reviewers).size < 2)
      fail("certain truth requires independent reviewers");
    if (truth.certainty !== "certain" && truth.clearMarkedSupported)
      fail("uncertain truth cannot be a supported positive");
    const fragments = truth.travelLaneFragments ?? [];
    if (fragments.length && truth.maskScope !== "visible-fragments")
      fail("fragment truth requires visible-fragments scope");
    const indices = [
      ...truth.preferredLanes,
      ...truth.signSpans.flat(),
      ...fragments.map((f) => f.lane),
    ];
    if (
      !Number.isInteger(truth.laneCount) ||
      truth.laneCount < (truth.photoRelevant ? 1 : 0) ||
      (truth.laneCount === 0 && truth.travelLanes.length > 0) ||
      indices.some((i) => !Number.isInteger(i) || i < 0 || i >= truth.laneCount)
    )
      fail("lane index outside layout");
    if (truth.signSpans.some((span) => span.some((lane, i) => i > 0 && lane !== span[i - 1] + 1)))
      fail("sign span is not contiguous");
    if (truth.clearMarkedSupported && truth.maskScope === "visible-fragments")
      fail("fragment truth cannot certify complete-layout usefulness");
    if (
      truth.clearMarkedSupported &&
      (!photo ||
        !truth.photoRelevant ||
        truth.travelLanes.length !== truth.laneCount ||
        !truth.preferredLanes.length)
    )
      fail("supported positive lacks target masks");
    for (const polygon of [
      ...truth.travelLanes,
      ...fragments.map((f) => f.polygon),
      ...truth.forbidden,
    ]) {
      if (
        !hasArea(polygon) ||
        polygon.some(
          ([x, y]) =>
            !Number.isFinite(x) ||
            !Number.isFinite(y) ||
            x < 0 ||
            y < 0 ||
            (photo && (x > photo.width || y > photo.height)),
        )
      )
        fail("invalid pixel mask");
    }
  }
  return [...new Set(errors)];
}

function inside([x, y]: Pixel, polygon: Pixel[]): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, ay] = polygon[i];
    const [bx, by] = polygon[j];
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) hit = !hit;
  }
  return hit;
}

function edgeDistance([x, y]: Pixel, polygon: Pixel[]): number {
  let min = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const [ax, ay] = polygon[i];
    const [bx, by] = polygon[(i + 1) % polygon.length];
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    min = Math.min(min, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return min;
}

function contained(
  polygon: Pixel[],
  masks: Pixel[][],
  forbidden: Pixel[][],
  tolerance: number,
  spacing: number,
): boolean {
  if (!hasArea(polygon) || !masks.length || !masks.every(hasArea) || !forbidden.every(hasArea))
    return false;
  const valid = (p: Pixel) =>
    masks.some((mask) => inside(p, mask) || edgeDistance(p, mask) <= tolerance) &&
    !forbidden.some((area) => inside(p, area));
  if (!polygon.every(valid)) return false;
  const xs = polygon.map(([x]) => x);
  const ys = polygon.map(([, y]) => y);
  for (let y = Math.min(...ys); y <= Math.max(...ys); y += spacing) {
    for (let x = Math.min(...xs); x <= Math.max(...xs); x += spacing) {
      const p: Pixel = [x, y];
      if (inside(p, polygon) && !valid(p)) return false;
    }
  }
  return true;
}

function overlapsInterior(polygon: Pixel[], mask: Pixel[]): boolean {
  if (polygon.some((point) => inside(point, mask)) || mask.some((point) => inside(point, polygon)))
    return true;
  const cross = (a: Pixel, b: Pixel, c: Pixel) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    for (let j = 0; j < mask.length; j++) {
      const c = mask[j];
      const d = mask[(j + 1) % mask.length];
      if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return true;
    }
  }
  return false;
}

export function scoreFrames(frames: ReferenceFrame[], outputs: FrameOutput[]) {
  let wrongLane = 0;
  let wrongScene = 0;
  let accepted = 0;
  let positives = 0;
  let positiveAccepted = 0;
  let unscorable = 0;
  let missing = 0;
  const byId = new Map(outputs.map((o) => [o.id, o]));
  for (const frame of frames) {
    const truth = frame.truth;
    if (!truth || truth.certainty !== "certain" || new Set(truth.reviewers).size < 2) {
      unscorable++;
      continue;
    }
    const usefulReference = truth.clearMarkedSupported && truth.maskScope !== "visible-fragments";
    if (usefulReference) positives++;
    const output = byId.get(frame.id);
    if (!output) {
      missing++;
      continue;
    }
    if (output.photoShown && !truth.photoRelevant) wrongScene++;
    if (!output.ribbons.length) continue;
    const scale = (frame.photo?.width ?? 390) / 390;
    const valid =
      output.photoShown &&
      truth.photoRelevant &&
      output.ribbons.every(
        (r) =>
          truth.preferredLanes.includes(r.lane) &&
          contained(
            r.polygon,
            [
              ...(truth.travelLanes[r.lane] ? [truth.travelLanes[r.lane]] : []),
              ...(truth.travelLaneFragments ?? [])
                .filter((f) => f.lane === r.lane)
                .map((f) => f.polygon),
            ],
            truth.forbidden,
            2 * scale,
            Math.max(0.5, scale),
          ),
      );
    if (!valid) {
      const knownFailure =
        !output.photoShown ||
        !truth.photoRelevant ||
        output.ribbons.some(
          (r) =>
            !truth.preferredLanes.includes(r.lane) ||
            !hasArea(r.polygon) ||
            [
              ...truth.forbidden,
              ...truth.travelLanes.filter((_, lane) => lane !== r.lane),
              ...(truth.travelLaneFragments ?? [])
                .filter((f) => f.lane !== r.lane)
                .map((f) => f.polygon),
            ].some((mask) => overlapsInterior(r.polygon, mask)),
        );
      if (truth.maskScope === "visible-fragments" && !knownFailure) unscorable++;
      else wrongLane++;
      continue;
    }
    accepted++;
    const complete = truth.preferredLanes.every((lane) =>
      output.ribbons.some((ribbon) => ribbon.lane === lane),
    );
    if (usefulReference && complete) positiveAccepted++;
  }
  return {
    wrongLane,
    wrongScene,
    accepted,
    positives,
    positiveAccepted,
    usefulness: positives ? positiveAccepted / positives : 0,
    unscorable,
    missing,
  };
}
