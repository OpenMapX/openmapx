import { expect, it } from "vitest";
import type { LngLat } from "../../types/geometry";
import type { JunctionDecisionPoint, JunctionWay } from "../../types/junction";
import type { StreetLevelImage } from "../../types/streetLevel";
import { photoApproachEvidence } from "../photoApproach";

const geometry: LngLat[] = [
  [0, 51],
  [0.005, 51],
];
const point: JunctionDecisionPoint = {
  stepIndex: 1,
  kind: "exit",
  side: "right",
  point: geometry[1],
  alongMeters: 350,
  approachBearing: 90,
  divergenceDeg: 20,
  activeLanes: [],
};
const image: StreetLevelImage = {
  id: "photo",
  providerId: "panoramax",
  lngLat: [0.0035, 51],
  heading: 90,
  isPano: false,
  assets: {},
};
const way: JunctionWay = {
  wayId: 1,
  highway: "motorway",
  bearing: 90,
  startDistanceMeters: 300,
  endDistanceMeters: 0,
  tags: { lanes: 2 },
  geometry,
};
it("uses the tunnel interval at the camera rather than the surface interval at the split", () => {
  const split = {
    ...way,
    wayId: 2,
    tags: { lanes: 3 },
    geometry: [
      [0.0048, 51],
      [0.005, 51],
    ] as LngLat[],
  };
  expect(
    photoApproachEvidence(geometry, point, image, [
      {
        ...way,
        tunnel: true,
        layer: -1,
        geometry: [
          [0, 51],
          [0.0048, 51],
        ],
      },
      split,
    ]).way?.tunnel,
  ).toBe(true);
});
it("abstains at a stacked ambiguous road", () => {
  expect(
    photoApproachEvidence(geometry, point, image, [
      way,
      { ...way, wayId: 2, layer: 1, bridge: true },
    ]).state,
  ).toBe("conflict");
});
it("does not match a camera on a nearby service road to the motorway", () => {
  expect(
    photoApproachEvidence(geometry, point, { ...image, lngLat: [0.0035, 51.00018] }, [way]).state,
  ).toBe("unknown");
});
it("keeps an older response without geometry unknown", () => {
  expect(
    photoApproachEvidence(geometry, point, image, [{ ...way, geometry: undefined }]).state,
  ).toBe("unknown");
});

it("rejects a way whose shape runs in the opposite legal direction", () => {
  expect(
    photoApproachEvidence(geometry, point, image, [{ ...way, geometry: [...geometry].reverse() }])
      .state,
  ).toBe("unknown");
});
