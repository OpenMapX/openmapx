import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { LngLat } from "../../types/geometry";
import type { JunctionDecisionPoint } from "../../types/junction";
import type { StreetLevelImage } from "../../types/streetLevel";
import fixture from "../__fixtures__/junction/aachen-two-lane.json";
import { projectRoutePath } from "../photoProjection";
import { alignPhotoRoad } from "../photoRoadAlignment";

const geometry: LngLat[] = [
  [0, 51.18],
  [0.0045, 51.18],
];
const point: JunctionDecisionPoint = {
  stepIndex: 1,
  kind: "exit",
  side: "left",
  point: [0.0028653, 51.18],
  alongMeters: 200,
  approachBearing: 90,
  divergenceDeg: -15,
  laneCount: 4,
  activeLanes: [0, 1],
};
const image: StreetLevelImage = {
  id: "painted-road",
  providerId: "panoramax",
  lngLat: [0.0014327, 51.18],
  heading: 90,
  isPano: false,
  fovDeg: 90,
  aspectRatio: 4 / 3,
  assets: {},
};

/** Independent perspective drawing: four 3.5 m lanes, 2 m eye height, vanishing point (330, 250). */
function paintedRoad(markings = true, grass = false) {
  const width = 640,
    height = 480;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      const road = y > 250 && x > 330 - 2.625 * (y - 250) && x < 330 + 4.375 * (y - 250);
      const paint =
        markings &&
        road &&
        [-2.625, -0.875, 0.875, 2.625, 4.375].some(
          (slope) => Math.abs(x - (330 + slope * (y - 250))) < Math.max(1, (y - 250) * 0.02),
        );
      const colour = paint ? [235, 235, 235] : road && !grass ? [85, 85, 85] : [60, 110, 55];
      data.set([...colour, 255], at);
    }
  return { width, height, data };
}

describe("photo road registration", () => {
  it("finds a road camera pose from lane markings despite an incorrect compass centre", () => {
    const alignment = alignPhotoRoad(geometry, point, image, paintedRoad(), 4);
    expect(alignment).not.toBeNull();
    expect(alignment?.cameraHeightM).toBeGreaterThan(1.7);
    expect(alignment?.cameraHeightM).toBeLessThan(2.3);
    expect(alignment?.headingDeg).toBeGreaterThan(87);
    expect(alignment?.headingDeg).toBeLessThan(90);
  });

  it("keeps both allowed left-lane ribbons inside independently drawn road boundaries", () => {
    const alignment = alignPhotoRoad(geometry, point, image, paintedRoad(), 4);
    expect(alignment).not.toBeNull();
    const path = projectRoutePath(geometry, point, image, {
      alignment: alignment ?? undefined,
      exitLanes: { laneCount: 4, activeLanes: [0, 1] },
    });
    expect(path.visible).toBe(true);
    expect(path.ribbons).toHaveLength(2);
    expect(path.laneShiftMeters).toBe(0);
    for (const ribbon of path.ribbons ?? [])
      for (const sample of ribbon) {
        for (const edge of [sample.left, sample.right]) {
          if (!edge) throw new Error("Missing projected ribbon edge");
          const x = edge.xPercent * 6.4,
            y = edge.yPercent * 4.8;
          expect(x).toBeGreaterThan(330 - 2.625 * (y - 250) - 3);
          expect(x).toBeLessThan(330 + 0.875 * (y - 250) + 3);
        }
      }
  });

  it("rejects a uniform road image without markings rather than guessing a pose", () => {
    expect(alignPhotoRoad(geometry, point, image, paintedRoad(false), 4)).toBeNull();
  });

  it("rejects bright lines surrounded by grass rather than identifying them as a carriageway", () => {
    expect(alignPhotoRoad(geometry, point, image, paintedRoad(true, true), 4)).toBeNull();
  });

  it.each([3, 5])("rejects a %s-lane model on a visibly four-lane carriageway", (count) => {
    expect(alignPhotoRoad(geometry, point, image, paintedRoad(), count)).toBeNull();
  });

  it("draws only the contiguous road stretch supported by the actual pixels", () => {
    const pixels = paintedRoad();
    for (let y = 300; y < pixels.height; y++)
      for (let x = 0; x < pixels.width; x++) {
        const at = (y * pixels.width + x) * 4;
        if (pixels.data[at] === 85) pixels.data.set([60, 110, 55, 255], at);
      }
    const alignment = alignPhotoRoad(geometry, point, image, pixels, 4);
    expect(alignment).not.toBeNull();
    const path = projectRoutePath(geometry, point, image, {
      alignment: alignment ?? undefined,
      exitLanes: { laneCount: 4, activeLanes: [0, 1] },
    });
    expect(path.ribbons).toHaveLength(2);
    for (const ribbon of path.ribbons ?? [])
      for (const sample of ribbon) {
        expect((sample.yPercent * pixels.height) / 100).toBeLessThan(300);
      }
  });
});

const realPixels = {
  width: fixture.width,
  height: fixture.height,
  data: new Uint8ClampedArray(
    gunzipSync(
      readFileSync(new URL("../__fixtures__/junction/aachen-two-lane.rgba.gz", import.meta.url)),
    ),
  ),
};
const realPoint = fixture.point as unknown as JunctionDecisionPoint;
const realImage = fixture.image as StreetLevelImage;
const realGeometry = fixture.geometry as LngLat[];
describe("real motorway photo", () => {
  it("registers dashed lanes with grey hard shoulders on the correct carriageway", () => {
    const alignment = alignPhotoRoad(realGeometry, realPoint, realImage, realPixels, 2);
    expect(alignment).not.toBeNull();
    expect(alignment?.fromMeters).toBeLessThanOrEqual(16);
    expect(alignment?.headingDeg).toBeGreaterThanOrEqual(81);
    expect(alignment?.headingDeg).toBeLessThanOrEqual(93);
  });
  it.each([1, 3, 4])("rejects a %s-lane interpretation of the two-lane photo", (count) => {
    expect(alignPhotoRoad(realGeometry, realPoint, realImage, realPixels, count)).toBeNull();
  });
  it("keeps real-photo ribbons between independently traced paint boundaries", () => {
    const alignment = alignPhotoRoad(realGeometry, realPoint, realImage, realPixels, 2);
    expect(alignment).not.toBeNull();
    const path = projectRoutePath(realGeometry, realPoint, realImage, {
      alignment: alignment ?? undefined,
      exitLanes: { laneCount: 2, activeLanes: [0, 1] },
    });
    expect(path.ribbons).toHaveLength(2);
    const xAtRow = (
      points: NonNullable<typeof path.ribbons>[number],
      edge: "left" | "right",
      row: number,
    ) => {
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1][edge],
          b = points[i][edge];
        if (!a || !b) throw new Error("Missing ribbon edge");
        const ay = a.yPercent * 10.24,
          by = b.yPercent * 10.24;
        if (row <= ay && row >= by)
          return (a.xPercent + ((b.xPercent - a.xPercent) * (row - ay)) / (by - ay)) * 20.48;
      }
      throw new Error(`Ribbon does not cover source row ${row}`);
    };
    // Source photo inspected at its original 2048 × 1024 size; these are the
    // asphalt-facing edges of the solid outer paint, independent of the fit.
    for (const [y, left, right] of [
      [545, 954, 1050],
      [560, 903, 1061],
      [580, 829, 1077],
    ]) {
      for (const ribbon of path.ribbons ?? []) {
        expect(xAtRow(ribbon, "left", y)).toBeGreaterThan(left - 3);
        expect(xAtRow(ribbon, "right", y)).toBeLessThan(right + 3);
      }
    }
    // The dashed divider is visible here at x989–990; each ribbon stays on
    // its own side, so a fit cannot merely put both strips somewhere on asphalt.
    const [leftLane, rightLane] = path.ribbons ?? [];
    expect(xAtRow(leftLane, "right", 550)).toBeLessThan(989);
    expect(xAtRow(rightLane, "left", 550)).toBeGreaterThan(990);
  });
});
