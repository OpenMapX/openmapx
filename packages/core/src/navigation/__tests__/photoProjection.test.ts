import { describe, expect, it } from "vitest";
import type { LngLat } from "../../types/geometry";
import type { JunctionDecisionPoint } from "../../types/junction";
import type { Route } from "../../types/routing";
import type { StreetLevelImage } from "../../types/streetLevel";
import fixture from "../__fixtures__/junction/a57-neuss-exit20.json";
import { cumulativeDistances, positionAt } from "../deadReckon";
import { findJunctionDecisionPoints } from "../junctionDetect";
import { projectRoutePath } from "../photoProjection";

const LAT = 51.18;
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LNG = 111320 * Math.cos((LAT * Math.PI) / 180);

/** `straightM` due east, then `bendM` at `bendDeg` off east — an exit ramp. */
function road(straightM: number, bendDeg = 0, bendM = 0, stepM = 10): LngLat[] {
  let cursor: LngLat = [0, LAT];
  const points: LngLat[] = [cursor];
  const walk = (bearingDeg: number, distance: number) => {
    const rad = (bearingDeg * Math.PI) / 180;
    cursor = [
      cursor[0] + (Math.sin(rad) * distance) / M_PER_DEG_LNG,
      cursor[1] + (Math.cos(rad) * distance) / M_PER_DEG_LAT,
    ];
    points.push(cursor);
  };
  for (let walked = 0; walked < straightM; walked += stepM) walk(90, stepM);
  for (let walked = 0; walked < bendM; walked += stepM) walk(90 + bendDeg, stepM);
  return points;
}

function decisionPoint(
  geometry: LngLat[],
  alongMeters: number,
  divergenceDeg: number,
): JunctionDecisionPoint {
  const cum = cumulativeDistances(geometry);
  return {
    stepIndex: 1,
    kind: "exit",
    side: divergenceDeg < 0 ? "left" : "right",
    point: positionAt(geometry, cum, alongMeters).point,
    alongMeters,
    approachBearing: 90,
    divergenceDeg,
    activeLanes: [],
  };
}

function camera(
  geometry: LngLat[],
  alongMeters: number,
  overrides: Partial<StreetLevelImage> = {},
): StreetLevelImage {
  const cum = cumulativeDistances(geometry);
  return {
    id: "photo",
    providerId: "panoramax",
    lngLat: positionAt(geometry, cum, alongMeters).point,
    heading: 90,
    isPano: false,
    fovDeg: 70,
    assets: {},
    ...overrides,
  };
}

describe("projectRoutePath", () => {
  it("draws a straight road as a centred path running up to the horizon", () => {
    const geometry = road(400);
    const path = projectRoutePath(geometry, decisionPoint(geometry, 300, 0), camera(geometry, 200));
    expect(path.visible).toBe(true);
    expect(path.points.length).toBeGreaterThan(5);
    for (const projected of path.points) {
      expect(projected.xPercent).toBeCloseTo(50, 1);
      expect(projected.yPercent).toBeGreaterThan(50);
      expect(projected.yPercent).toBeLessThanOrEqual(100);
    }
    // Near points sit low in the frame, far ones climb toward the horizon.
    const [nearest] = path.points;
    const farthest = path.points[path.points.length - 1];
    expect(nearest.distanceMeters).toBeLessThan(farthest.distanceMeters);
    expect(nearest.yPercent).toBeGreaterThan(farthest.yPercent);
    expect(farthest.yPercent).toBeLessThan(52);
  });

  it("tapers the path with distance, like a road seen in perspective", () => {
    const geometry = road(400);
    const path = projectRoutePath(geometry, decisionPoint(geometry, 300, 0), camera(geometry, 200));
    const [nearest] = path.points;
    const farthest = path.points[path.points.length - 1];
    expect(nearest.widthPercent).toBeGreaterThan(3 * farthest.widthPercent);
    expect(farthest.widthPercent).toBeGreaterThan(0);
    // Wide enough to read a few metres ahead, never a slab across the frame.
    expect(nearest.widthPercent).toBeGreaterThan(5);
    expect(nearest.widthPercent).toBeLessThan(40);
  });

  it("scales the vertical drop to the photo's own aspect ratio", () => {
    const geometry = road(400);
    const point = decisionPoint(geometry, 300, 0);
    // A wider frame packs the same lens into less height, so the road sits
    // lower in it than in a 4:3 frame of the same lens.
    const fourThree = projectRoutePath(
      geometry,
      point,
      camera(geometry, 200, { aspectRatio: 4 / 3 }),
    );
    const wide = projectRoutePath(geometry, point, camera(geometry, 200, { aspectRatio: 16 / 9 }));
    expect(wide.points[0].yPercent).toBeGreaterThan(fourThree.points[0].yPercent);
    // Without metadata the projection falls back to the 4:3 default.
    const unknown = projectRoutePath(geometry, point, camera(geometry, 200));
    expect(unknown.points[0].yPercent).toBeCloseTo(fourThree.points[0].yPercent, 6);
  });

  it("starts the path at the bottom edge of a frame that does not see the road close up", () => {
    const geometry = road(400);
    const point = decisionPoint(geometry, 300, 0);
    // A 16:9 frame through a 60° lens, and a 4:3 one through 40°, first see
    // the road several metres further out than the near clip.
    for (const overrides of [
      { fovDeg: 60, aspectRatio: 16 / 9 },
      { fovDeg: 40, aspectRatio: 4 / 3 },
    ]) {
      const path = projectRoutePath(geometry, point, camera(geometry, 200, overrides));
      expect(path.visible).toBe(true);
      expect(path.points.length).toBeGreaterThan(5);
      expect(path.points[0].yPercent).toBeGreaterThan(99);
      for (const projected of path.points) expect(projected.yPercent).toBeLessThanOrEqual(100);
    }
  });

  it("bends toward the exit side of the frame on a right-hand ramp", () => {
    const geometry = road(300, 25, 100);
    const path = projectRoutePath(
      geometry,
      decisionPoint(geometry, 300, 25),
      camera(geometry, 220),
    );
    const [nearest] = path.points;
    const farthest = path.points[path.points.length - 1];
    expect(nearest.xPercent).toBeCloseTo(50, 1);
    expect(farthest.xPercent).toBeGreaterThan(55);
    expect(path.headRotateDeg).toBeGreaterThan(0);
  });

  it("mirrors the bend for a left-hand exit", () => {
    const geometry = road(300, -25, 100);
    const path = projectRoutePath(
      geometry,
      decisionPoint(geometry, 300, -25),
      camera(geometry, 220),
    );
    expect(path.points[path.points.length - 1].xPercent).toBeLessThan(45);
    expect(path.headRotateDeg).toBeLessThan(0);
  });

  it("stays inside the frame by ending the path where the route leaves it", () => {
    const geometry = road(300, 60, 120);
    const narrow = projectRoutePath(
      geometry,
      decisionPoint(geometry, 300, 60),
      camera(geometry, 250, { fovDeg: 40 }),
    );
    const wide = projectRoutePath(
      geometry,
      decisionPoint(geometry, 300, 60),
      camera(geometry, 250, { fovDeg: 100 }),
    );
    expect(narrow.points.length).toBeLessThan(wide.points.length);
    for (const projected of narrow.points) {
      expect(projected.xPercent).toBeGreaterThanOrEqual(0);
      expect(projected.xPercent).toBeLessThanOrEqual(100);
    }
  });

  it("draws nothing when the photo faces away from the road", () => {
    const geometry = road(400);
    const path = projectRoutePath(
      geometry,
      decisionPoint(geometry, 300, 0),
      camera(geometry, 200, { heading: 150 }),
    );
    expect(path.visible).toBe(false);
    expect(path.points).toEqual([]);
  });

  it("draws nothing when the photo was taken well off the route", () => {
    const geometry = road(400);
    const onRoute = camera(geometry, 200);
    const asideLngLat: LngLat = [onRoute.lngLat[0], onRoute.lngLat[1] + 60 / M_PER_DEG_LAT];
    const path = projectRoutePath(geometry, decisionPoint(geometry, 300, 0), {
      ...onRoute,
      lngLat: asideLngLat,
    });
    expect(path.visible).toBe(false);
  });

  it("draws nothing over a flat photo whose field of view is unknown", () => {
    const geometry = road(400);
    const { fovDeg: _unknown, ...unknownLens } = camera(geometry, 200);
    const path = projectRoutePath(geometry, decisionPoint(geometry, 300, 0), unknownLens);
    expect(path.visible).toBe(false);
    expect(path.points).toEqual([]);
  });

  it("draws nothing when the photo was taken past the decision point", () => {
    const geometry = road(400);
    const path = projectRoutePath(geometry, decisionPoint(geometry, 300, 0), camera(geometry, 340));
    expect(path.visible).toBe(false);
  });

  it("maps a panorama across the full 360° frame and reports its crop window", () => {
    const geometry = road(300, 60, 120);
    const point = decisionPoint(geometry, 300, 60);
    // Close to the split, where the ramp sweeps past the edge of a 70° lens.
    const pano = camera(geometry, 280, { isPano: true, fovDeg: 360 });
    const path = projectRoutePath(geometry, point, pano);
    const flat = projectRoutePath(geometry, point, camera(geometry, 280));
    // 360° of frame: the whole bend stays in the image where a 70° lens clips it.
    expect(path.points.length).toBeGreaterThan(flat.points.length);
    expect(path.crop?.spanDeg).toBe(90);
    expect(path.crop?.startDeg).toBeCloseTo(90 - 45, 0);
    // Equirectangular is linear in angle, so the bend stays near the centre of
    // the full-width image: a 60° turn is a sixth of the frame away.
    for (const projected of path.points) {
      expect(projected.xPercent).toBeGreaterThan(45);
      expect(projected.xPercent).toBeLessThan(75);
    }
  });

  it("places a panorama's path against the photo's heading, where its frame is centred", () => {
    const geometry = road(400);
    const point = decisionPoint(geometry, 300, 0);
    // Road runs east (90°); the panorama's centre column faces 110°.
    const pano = camera(geometry, 200, { isPano: true, fovDeg: 360, heading: 110 });
    const path = projectRoutePath(geometry, point, pano);
    expect(path.visible).toBe(true);
    for (const projected of path.points) {
      expect(projected.xPercent).toBeCloseTo(50 + (-20 / 360) * 100, 0);
    }
  });

  it("draws nothing over a panorama whose heading is unknown", () => {
    const geometry = road(400);
    const { heading: _unknown, ...noHeading } = camera(geometry, 200, {
      isPano: true,
      fovDeg: 360,
    });
    const path = projectRoutePath(geometry, decisionPoint(geometry, 300, 0), noHeading);
    expect(path.visible).toBe(false);
  });

  it("keeps a wider lens' path closer to the centre of the frame", () => {
    const geometry = road(300, 25, 100);
    const point = decisionPoint(geometry, 300, 25);
    const narrow = projectRoutePath(geometry, point, camera(geometry, 240, { fovDeg: 60 }));
    const wide = projectRoutePath(geometry, point, camera(geometry, 240, { fovDeg: 90 }));
    const lastX = (path: typeof narrow) => path.points[path.points.length - 1].xPercent;
    expect(lastX(wide)).toBeLessThan(lastX(narrow));
  });
});

describe("projectRoutePath into the exit lane", () => {
  // Eastbound, so "right of travel" is south.
  const LANE = 3.5;
  const aside = (image: StreetLevelImage, rightMeters: number): StreetLevelImage => ({
    ...image,
    lngLat: [image.lngLat[0], image.lngLat[1] - rightMeters / M_PER_DEG_LAT],
  });
  const threeLanesExitRight = { laneCount: 3, activeLanes: [2] };
  /** The projected sample closest to `meters` ahead of the camera. */
  const sampleAt = (path: ReturnType<typeof projectRoutePath>, meters: number) =>
    path.points.reduce((best, p) =>
      Math.abs(p.distanceMeters - meters) < Math.abs(best.distanceMeters - meters) ? p : best,
    );

  it("moves the path over into the exit lane when the photo was shot a lane beside it", () => {
    const geometry = road(400);
    const point = decisionPoint(geometry, 300, 0);
    // Shot in the middle lane (centre of the carriageway); the exit leaves the right lane.
    const photo = camera(geometry, 220);
    const plain = projectRoutePath(geometry, point, photo);
    const laned = projectRoutePath(geometry, point, photo, { exitLanes: threeLanesExitRight });
    // By the split, 80 m ahead, the path has crossed one lane to the right.
    expect(sampleAt(laned, 80).xPercent).toBeGreaterThan(sampleAt(plain, 80).xPercent + 1);
    expect(laned.laneShiftMeters).toBeCloseTo(LANE, 0);
  });

  it("keeps the path in its lane when the photo was already shot in the exit lane", () => {
    const geometry = road(400);
    const point = decisionPoint(geometry, 300, 0);
    const photo = aside(camera(geometry, 220), LANE);
    const path = projectRoutePath(geometry, point, photo, { exitLanes: threeLanesExitRight });
    expect(path.laneShiftMeters).toBeCloseTo(0, 0);
    expect(sampleAt(path, 60).xPercent).toBeCloseTo(50, 0);
  });

  it("always starts under the camera, whichever lane the exit leaves from", () => {
    const geometry = road(400);
    const point = decisionPoint(geometry, 300, 0);
    for (const offset of [-LANE, 0, LANE]) {
      const path = projectRoutePath(geometry, point, aside(camera(geometry, 220), offset), {
        exitLanes: threeLanesExitRight,
      });
      expect(path.points[0].xPercent).toBeCloseTo(50, 0);
    }
  });

  it("leaves the path alone when the lane layout says nothing about the exit", () => {
    const geometry = road(400);
    const point = decisionPoint(geometry, 300, 0);
    const photo = aside(camera(geometry, 220), -LANE);
    const plain = projectRoutePath(geometry, point, photo);
    const empty = projectRoutePath(geometry, point, photo, {
      exitLanes: { laneCount: 3, activeLanes: [] },
    });
    expect(empty.points).toEqual(plain.points);
    expect(empty.laneShiftMeters).toBe(0);
  });

  it("does not trust a GPS position beyond the carriageway edge", () => {
    const geometry = road(400);
    const point = decisionPoint(geometry, 300, 0);
    // 12 m right of the centre of a three-lane carriageway is off the road.
    const path = projectRoutePath(geometry, point, aside(camera(geometry, 220), 12), {
      exitLanes: threeLanesExitRight,
    });
    expect(path.visible).toBe(true);
    expect(path.laneShiftMeters).toBeGreaterThanOrEqual(-1.75 - 1e-6);
  });
});

describe("projectRoutePath on the A57 fixture", () => {
  const route = fixture.route as unknown as Route;
  const point = findJunctionDecisionPoints(route)[0];
  const image: StreetLevelImage = {
    id: "caea047f-f3c0-4819-8354-11805e6597c3",
    providerId: "panoramax",
    lngLat: [6.678013787, 51.1787552],
    heading: 282,
    capturedAt: "2019-09-10T06:24:34.836000+00:00",
    isPano: false,
    fovDeg: 70,
    assets: {},
  };

  it("projects the approach onto the real photo, leaning toward the ramp", () => {
    const path = projectRoutePath(route.geometry, point, image);
    expect(path.visible).toBe(true);
    expect(path.points.length).toBeGreaterThan(5);
    const [nearest] = path.points;
    const farthest = path.points[path.points.length - 1];
    expect(nearest.xPercent).toBeCloseTo(50, 0);
    expect(farthest.xPercent).toBeGreaterThan(nearest.xPercent);
    for (const projected of path.points) {
      expect(projected.xPercent).toBeGreaterThanOrEqual(0);
      expect(projected.xPercent).toBeLessThanOrEqual(100);
      expect(projected.yPercent).toBeGreaterThanOrEqual(0);
      expect(projected.yPercent).toBeLessThanOrEqual(100);
    }
  });
});
