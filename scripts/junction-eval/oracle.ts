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
    laneCount: number;
    signSpans: number[][];
    travelLanes: Pixel[][];
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
    const indices = [...truth.preferredLanes, ...truth.signSpans.flat()];
    if (
      !Number.isInteger(truth.laneCount) ||
      truth.laneCount < 1 ||
      indices.some((i) => !Number.isInteger(i) || i < 0 || i >= truth.laneCount)
    )
      fail("lane index outside layout");
    if (truth.signSpans.some((span) => span.some((lane, i) => i > 0 && lane !== span[i - 1] + 1)))
      fail("sign span is not contiguous");
    if (
      truth.clearMarkedSupported &&
      (!photo ||
        !truth.photoRelevant ||
        truth.travelLanes.length !== truth.laneCount ||
        !truth.preferredLanes.length)
    )
      fail("supported positive lacks target masks");
    for (const polygon of [...truth.travelLanes, ...truth.forbidden]) {
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
  mask: Pixel[],
  forbidden: Pixel[][],
  tolerance: number,
  spacing: number,
): boolean {
  if (!hasArea(polygon) || !hasArea(mask) || !forbidden.every(hasArea)) return false;
  const valid = (p: Pixel) =>
    (inside(p, mask) || edgeDistance(p, mask) <= tolerance) &&
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
    if (truth.clearMarkedSupported) positives++;
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
            truth.travelLanes[r.lane] ?? [],
            truth.forbidden,
            2 * scale,
            Math.max(0.5, scale),
          ),
      );
    if (!valid) {
      wrongLane++;
      continue;
    }
    accepted++;
    const complete = truth.preferredLanes.every((lane) =>
      output.ribbons.some((ribbon) => ribbon.lane === lane),
    );
    if (truth.clearMarkedSupported && complete) positiveAccepted++;
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
